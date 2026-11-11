// /api/local/personas: listing, creating and switching personas, and each one's files. Every id,
// kind and file name a path carries is checked before it touches the disk, and every write goes to
// the user's copy in the data home; a template is only ever read.
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  activePersona,
  dataHome,
  isPlainObject,
  isValidTimeZone,
  personaHomeDir,
  personaIds,
  personaTemplateDir,
  readPersonaIdentity,
  resolvePersonaPath,
  sourceFolder,
  templatesDir,
} from "@eidolon/config";
import { REFERENCE_EXTENSIONS } from "@eidolon/imagegen";
import { transcribe } from "@eidolon/ingest";
import { readBytes } from "../../responses.ts";
import {
  type IdentityUpdate,
  LOCAL_ROUTES,
  type PersonaIdentityFields,
  type PersonaSummary,
  type PersonasResponse,
  REFERENCE_KINDS,
  type ReferenceKind,
} from "../api.ts";
import {
  AVATAR_STEM,
  editSettingsYaml,
  factFile,
  findAvatar,
  IDENTITY_FIELDS,
  IMAGE_EXTENSIONS,
  indexStatus,
  listFacts,
  listReferences,
  personaRefusal,
  promptFile,
  readIdentityFields,
  renamedFor,
  type SniffedImage,
  setDotted,
  sniffImage,
  writeFailure,
  writeIdentityFields,
  writeNewPersona,
} from "../personas.ts";
import { imageResponse, localError, localJson, NO_STORE, readJson } from "../responses.ts";
import { reinstallSettings } from "../restart.ts";
import type { LocalApp, LocalRouteSpec } from "../router.ts";
import {
  checkFileName,
  fileIn,
  isInside,
  isPersonaId,
  personaWriteTarget,
  readPersonaFile,
  updatePersonaFile,
  WriteRefused,
  writeDataFile,
} from "../write.ts";
import { switchRefusal } from "./settings.ts";
import { VOICE_ID } from "./voices.ts";

/** Upload cap, counted while the body streams. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Fact files run to hundreds of KB; the JSON body allows for a few MB of them. */
const FACTS_BODY_LIMIT = 8 * 1024 * 1024;

/** Every literal word of the API's paths: an id among them would read as a route. */
const RESERVED_IDS = new Set(
  LOCAL_ROUTES.flatMap((route) => (route.split(" ")[1] as string).split("/")).filter(
    (segment) => segment !== "" && !segment.startsWith(":"),
  ),
);

const CONTROL = /\p{Cc}/u;

/** Typed by the bytes, never by the name. */
async function serveImage(path: string): Promise<Response> {
  const bytes = await Bun.file(path).bytes();
  const image = sniffImage(bytes);
  if (image === null) {
    return localError(415, "unsupported-media-type", "Only PNG, JPEG and WebP images are shown");
  }
  return imageResponse(bytes, image.type, { "cache-control": NO_STORE });
}

/** An upload's bytes and type, or the 413 or 415 to answer. */
async function readUpload(
  request: Request,
): Promise<{ bytes: Uint8Array; image: SniffedImage } | Response> {
  const bytes = await readBytes(request, MAX_UPLOAD_BYTES);
  if (bytes === null) {
    return localError(413, "payload-too-large", "An image may be 20 MiB at most");
  }
  const image = sniffImage(bytes);
  if (image === null) {
    return localError(415, "unsupported-media-type", "Upload a PNG, JPEG or WebP image");
  }
  return { bytes, image };
}

/** A folder the app may delete in: really under the data home, and outside every template. */
function userFolder(folder: string): boolean {
  try {
    const real = realpathSync(folder);
    return (
      isInside(real, realpathSync(dataHome())) && !isInside(real, realpathSync(templatesDir()))
    );
  } catch {
    return false;
  }
}

function kindOf(raw: string): ReferenceKind | null {
  return (REFERENCE_KINDS as readonly string[]).includes(raw) ? (raw as ReferenceKind) : null;
}

/** One line of text, or null when the field holds anything else. */
function line(value: unknown, max: number): string | null {
  if (typeof value !== "string" || CONTROL.test(value)) return null;
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : null;
}

/**
 * The identity fields a body sends, checked; "" leaves a field to its default. With `partial`, a
 * field the body leaves out is left out, so a save can't undo another card's newer value.
 */
function identityFrom(body: Record<string, unknown>, partial: true): IdentityUpdate | Response;
function identityFrom(body: Record<string, unknown>): PersonaIdentityFields | Response;
function identityFrom(
  body: Record<string, unknown>,
  partial = false,
): PersonaIdentityFields | IdentityUpdate | Response {
  const limits = { name: 64, shortName: 32, fans: 32, summary: 500, timezone: 64 } as const;
  const fields: Record<string, string> = {};
  for (const key of IDENTITY_FIELDS) {
    if (partial && !Object.hasOwn(body, key)) continue;
    const value = line(body[key] ?? "", limits[key]);
    if (value === null) {
      return localError(400, "bad-request", `identity ${key} is one line of text, or too long`);
    }
    fields[key] = value;
  }
  if (fields.timezone && !isValidTimeZone(fields.timezone)) {
    return localError(400, "bad-request", "The time zone is not an IANA zone name");
  }
  return fields as unknown as PersonaIdentityFields | IdentityUpdate;
}

function summaryOf(id: string): PersonaSummary {
  const identity = readPersonaIdentity(id);
  return {
    id,
    name: identity.name,
    shortName: identity.shortName,
    template: existsSync(personaTemplateDir(id)),
    own: existsSync(personaHomeDir(id)),
    avatar: findAvatar(id) !== null,
  };
}

function personasResponse(): PersonasResponse {
  return { active: activePersona().id, personas: personaIds().map(summaryOf) };
}

/** A persona's text file: the user's copy, else the template's. */
function textOf(id: string, rel: string): { text: string; source: "own" | "template" | null } {
  if (existsSync(join(personaHomeDir(id), rel))) {
    return { text: readPersonaFile(id, rel) ?? "", source: "own" };
  }
  const text = readPersonaFile(id, rel);
  return text === null ? { text: "", source: null } : { text, source: "template" };
}

/** What the transcriber would make of the glossary: TOML, then Soniox's shape. */
function glossaryErrors(id: string): string[] {
  const path = resolvePersonaPath(id, "glossary.toml");
  if (!existsSync(path)) return [];
  try {
    transcribe.loadContext(path);
    return [];
  } catch (error) {
    // Only the transcriber's own verdicts are shown; anything else is a bug, and a 500.
    if (!(error instanceof transcribe.TranscribeError)) throw error;
    const { message } = error;
    return [message.startsWith(`${path}: `) ? message.slice(path.length + 2) : message];
  }
}

function glossaryOf(id: string) {
  return { ...textOf(id, "glossary.toml"), errors: glossaryErrors(id) };
}

/** Where the glossary sits for the bundler, which reads it from memory, never from the disk. */
const GLOSSARY_ENTRY = "/glossary.toml";

/**
 * Where the TOML stops parsing, as `line L, column C: reason` with both counted from 1; the
 * parser's quote of the text there is left out. Null when it parses.
 */
async function tomlError(text: string): Promise<string | null> {
  try {
    Bun.TOML.parse(text);
    return null;
  } catch (error) {
    // Bun.TOML.parse's error has `line` and `column`, but they are JavaScriptCore's: where this
    // file called it. Bun.build parses TOML with the same parser and logs the text's own place.
    const built = await Bun.build({
      entrypoints: [GLOSSARY_ENTRY],
      files: { [GLOSSARY_ENTRY]: text },
      throw: false,
    });
    const log = built.logs.find((entry) => entry.position !== null);
    const reason = (log?.message ?? String((error as { message?: unknown }).message ?? ""))
      .replace(/^TOML Parse error:\s*/, "")
      .replace(/:?\s*"[^"]*"/g, "");
    const at = log?.position;
    return at ? `line ${at.line}, column ${at.column}: ${reason}` : reason;
  }
}

async function textBody(request: Request, limit?: number): Promise<string | Response> {
  const body = await readJson(request, limit);
  if (!body.ok) return body.response;
  const text = isPlainObject(body.value) ? body.value.text : undefined;
  if (typeof text !== "string") return localError(400, "bad-request", "Send {text}");
  return text;
}

/**
 * `name` in persona `id`'s folder `kind`, checked: any image the selfie tool takes, as the folder
 * lists them. The user's copy is where writes go.
 */
function referenceTarget(
  id: string,
  kind: string,
  raw: string,
): { folder: string; name: string } | Response {
  const checkedKind = kindOf(kind);
  if (checkedKind === null) return localError(400, "bad-request", "The kind is outfits or friends");
  const name = checkFileName(raw, REFERENCE_EXTENSIONS);
  if (name === null) return localError(400, "invalid-file-name", "Name an image file");
  return { folder: join(personaHomeDir(id), "references", checkedKind), name };
}

/** The file `name` in `folder`, or the 400 for a name that leaves it. */
function within(folder: string, name: string): string | Response {
  try {
    return fileIn(folder, name);
  } catch (error) {
    if (error instanceof WriteRefused) {
      return localError(400, "invalid-file-name", "That name leaves its folder");
    }
    throw error;
  }
}

/** Fact file `raw` in persona `id`'s facts folder, checked, or the 400 to answer. */
function factTarget(
  id: string,
  raw: string,
): { folder: string; name: string; path: string } | Response {
  const name = checkFileName(raw, [".txt"]);
  if (name === null) return localError(400, "invalid-file-name", "Name a .txt file");
  const folder = sourceFolder(id, "facts");
  const path = within(folder, name);
  return path instanceof Response ? path : { folder, name, path };
}

/** Her prompt file, relative to her folder, or the 409 when her setting names one outside it. */
function promptTarget(id: string): string | Response {
  return (
    promptFile(id) ??
    localError(409, "invalid-path", "Her prompt setting names a file outside her folder")
  );
}

export function personasRoutes(app: LocalApp): LocalRouteSpec[] {
  /** Persona routes under :id run only for a persona that exists. */
  const forPersona =
    (
      handler: (
        request: Request,
        id: string,
        params: Readonly<Record<string, string>>,
      ) => Response | Promise<Response>,
    ): LocalRouteSpec["handler"] =>
    (request, { params }) => {
      const id = params.id as string;
      return personaRefusal(id) ?? handler(request, id, params);
    };

  return [
    { route: "GET /api/local/personas", handler: () => localJson(200, personasResponse()) },
    {
      route: "POST /api/local/personas",
      async handler(request) {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        if (!isPlainObject(body.value)) {
          return localError(400, "bad-request", "Send the new persona's fields");
        }
        const { id, voiceId } = body.value;
        if (!isPersonaId(id) || RESERVED_IDS.has(id)) {
          return localError(400, "invalid-persona-id", "A persona id is a lowercase slug");
        }
        if (personaIds().includes(id) || existsSync(personaHomeDir(id))) {
          return localError(409, "persona-exists", "A persona has that id already");
        }
        const fields = identityFrom(body.value);
        if (fields instanceof Response) return fields;
        if (fields.name === "") return localError(400, "bad-request", "A new persona needs a name");
        if (typeof voiceId !== "string" || !VOICE_ID.test(voiceId)) {
          return localError(400, "bad-request", "Pick a Fish voice for her");
        }
        try {
          writeNewPersona(id, fields, voiceId);
        } catch (error) {
          return writeFailure(error);
        }
        return localJson(201, summaryOf(id));
      },
    },
    {
      route: "PUT /api/local/personas/active",
      async handler(request) {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const id = isPlainObject(body.value) ? body.value.id : undefined;
        if (typeof id !== "string") return localError(400, "bad-request", "Send {id}");
        const refused = personaRefusal(id) ?? switchRefusal(app);
        if (refused !== null) return refused;
        try {
          editSettingsYaml((tree) => setDotted(tree, "persona", id));
        } catch (error) {
          return writeFailure(error);
        }
        reinstallSettings(app);
        return localJson(200, personasResponse());
      },
    },

    {
      route: "GET /api/local/personas/:id/prompt",
      handler: forPersona((_request, id) => {
        const rel = promptTarget(id);
        return rel instanceof Response ? rel : localJson(200, textOf(id, rel));
      }),
    },
    {
      route: "PUT /api/local/personas/:id/prompt",
      handler: forPersona(async (request, id) => {
        const rel = promptTarget(id);
        if (rel instanceof Response) return rel;
        const text = await textBody(request);
        if (text instanceof Response) return text;
        try {
          updatePersonaFile(id, rel, () => text);
        } catch (error) {
          return writeFailure(error);
        }
        return localJson(200, textOf(id, rel));
      }),
    },
    {
      route: "GET /api/local/personas/:id/glossary",
      handler: forPersona((_request, id) => localJson(200, glossaryOf(id))),
    },
    {
      route: "PUT /api/local/personas/:id/glossary",
      handler: forPersona(async (request, id) => {
        const text = await textBody(request);
        if (text instanceof Response) return text;
        const error = await tomlError(text);
        if (error !== null) return localError(400, "invalid-toml", error);
        try {
          writeDataFile(personaWriteTarget(id, "glossary.toml"), text);
        } catch (failure) {
          return writeFailure(failure);
        }
        return localJson(200, glossaryOf(id));
      }),
    },
    {
      route: "GET /api/local/personas/:id/identity",
      handler: forPersona((_request, id) => {
        try {
          return localJson(200, readIdentityFields(id));
        } catch (error) {
          return writeFailure(error);
        }
      }),
    },
    {
      route: "PUT /api/local/personas/:id/identity",
      handler: forPersona(async (request, id) => {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        if (!isPlainObject(body.value)) {
          return localError(400, "bad-request", "Send the identity fields");
        }
        const fields = identityFrom(body.value, true);
        if (fields instanceof Response) return fields;
        try {
          writeIdentityFields(id, fields);
        } catch (error) {
          return writeFailure(error);
        }
        if (id === activePersona().id) reinstallSettings(app);
        return localJson(200, readIdentityFields(id));
      }),
    },

    {
      route: "GET /api/local/personas/:id/references",
      handler: forPersona((_request, id) => {
        const avatar = findAvatar(id);
        return localJson(200, {
          outfits: listReferences(id, "outfits"),
          friends: listReferences(id, "friends"),
          avatar:
            avatar === null
              ? null
              : { name: avatar.name, source: avatar.source, size: avatar.size },
        });
      }),
    },
    {
      route: "GET /api/local/personas/:id/references/:kind/:name",
      image: true,
      handler: forPersona(async (_request, id, params) => {
        const target = referenceTarget(id, params.kind as string, params.name as string);
        if (target instanceof Response) return target;
        const kind = params.kind as ReferenceKind;
        for (const root of [personaHomeDir(id), personaTemplateDir(id)]) {
          const path = within(join(root, "references", kind), target.name);
          if (path instanceof Response) return path;
          if (existsSync(path)) return serveImage(path);
        }
        return localError(404, "not-found", "No such image");
      }),
    },
    {
      route: "POST /api/local/personas/:id/references/:kind/:name",
      handler: forPersona(async (request, id, params) => {
        const target = referenceTarget(id, params.kind as string, params.name as string);
        if (target instanceof Response) return target;
        if (checkFileName(target.name, IMAGE_EXTENSIONS) === null) {
          return localError(400, "invalid-file-name", "Name a .png, .jpg or .webp file");
        }
        const upload = await readUpload(request);
        if (upload instanceof Response) return upload;
        const name = checkFileName(renamedFor(target.name, upload.image), IMAGE_EXTENSIONS);
        if (name === null) return localError(400, "invalid-file-name", "That name is too long");
        try {
          writeDataFile(join(target.folder, name), upload.bytes);
        } catch (error) {
          return writeFailure(error);
        }
        return localJson(200, { name, source: "own", size: upload.bytes.byteLength });
      }),
    },
    {
      route: "DELETE /api/local/personas/:id/references/:kind/:name",
      handler: forPersona((_request, id, params) => {
        const target = referenceTarget(id, params.kind as string, params.name as string);
        if (target instanceof Response) return target;
        const own = within(target.folder, target.name);
        if (own instanceof Response) return own;
        if (existsSync(own) && userFolder(dirname(own))) {
          rmSync(own, { force: true });
          return localJson(200, { ok: true });
        }
        const template = join(
          personaTemplateDir(id),
          "references",
          params.kind as string,
          target.name,
        );
        if (existsSync(template)) {
          return localError(409, "template-file", "This image ships with Eidolon and stays");
        }
        return localError(404, "not-found", "No such image");
      }),
    },
    {
      route: "GET /api/local/personas/:id/avatar",
      image: true,
      handler: forPersona(async (_request, id) => {
        const avatar = findAvatar(id);
        return avatar === null
          ? localError(404, "not-found", "She has no avatar")
          : serveImage(avatar.path);
      }),
    },
    {
      route: "PUT /api/local/personas/:id/avatar",
      handler: forPersona(async (request, id) => {
        const upload = await readUpload(request);
        if (upload instanceof Response) return upload;
        const folder = personaHomeDir(id);
        const name = `${AVATAR_STEM}${upload.image.extension}`;
        try {
          writeDataFile(join(folder, name), upload.bytes);
        } catch (error) {
          return writeFailure(error);
        }
        // Exactly one avatar: the new one replaces any of another type.
        for (const extension of IMAGE_EXTENSIONS) {
          const other = `${AVATAR_STEM}${extension}`;
          if (other !== name && userFolder(folder)) rmSync(join(folder, other), { force: true });
        }
        return localJson(200, { name, source: "own", size: upload.bytes.byteLength });
      }),
    },
    {
      route: "DELETE /api/local/personas/:id/avatar",
      handler: forPersona((_request, id) => {
        const avatar = findAvatar(id);
        if (avatar === null) return localError(404, "not-found", "She has no avatar");
        if (avatar.source === "template") {
          return localError(409, "template-file", "This avatar ships with Eidolon and stays");
        }
        const folder = dirname(avatar.path);
        if (userFolder(folder)) {
          for (const extension of IMAGE_EXTENSIONS) {
            rmSync(join(folder, `${AVATAR_STEM}${extension}`), { force: true });
          }
        }
        return localJson(200, { ok: true });
      }),
    },

    {
      route: "GET /api/local/personas/:id/facts",
      handler: forPersona((_request, id) => localJson(200, listFacts(id))),
    },
    {
      route: "GET /api/local/personas/:id/facts/:file",
      handler: forPersona((_request, id, params) => {
        const target = factTarget(id, params.file as string);
        if (target instanceof Response) return target;
        let bytes: Buffer;
        try {
          bytes = readFileSync(target.path);
        } catch {
          return localError(404, "not-found", "No such fact file");
        }
        try {
          return localJson(200, { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
        } catch {
          return localError(409, "conflict", "This file isn't UTF-8 text");
        }
      }),
    },
    {
      route: "PUT /api/local/personas/:id/facts/:file",
      handler: forPersona(async (request, id, params) => {
        const target = factTarget(id, params.file as string);
        if (target instanceof Response) return target;
        const text = await textBody(request, FACTS_BODY_LIMIT);
        if (text instanceof Response) return text;
        try {
          writeDataFile(target.path, text);
        } catch (error) {
          return writeFailure(error);
        }
        return localJson(200, factFile(id, target.name));
      }),
    },
    {
      route: "DELETE /api/local/personas/:id/facts/:file",
      handler: forPersona((_request, id, params) => {
        const target = factTarget(id, params.file as string);
        if (target instanceof Response) return target;
        if (!existsSync(target.path)) return localError(404, "not-found", "No such fact file");
        if (!userFolder(target.folder)) {
          return localError(403, "forbidden", "Eidolon deletes only in its data home");
        }
        rmSync(target.path, { force: true });
        return localJson(200, { ok: true });
      }),
    },
    {
      route: "GET /api/local/personas/:id/index",
      handler: forPersona((_request, id) => localJson(200, indexStatus(id))),
    },
  ];
}
