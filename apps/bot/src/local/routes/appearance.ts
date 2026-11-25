// /api/local/personas/:id/models: her character models, each a .p2lrt that PSD2Live's runtime
// loaded before it was kept. Importing one never makes it hers to show: PUT settings'
// appearance.model does.
import { readSettingsLayers } from "@eidolon/config";
import { readBytes } from "../../responses.ts";
import { type CharacterModel, MAX_MODEL_BYTES, type ModelInventory } from "../api.ts";
import {
  activeModel,
  checkPatch,
  deleteModel,
  importModel,
  isModelId,
  listModels,
  patchModel,
  readModel,
  replaceRig,
  rigPath,
} from "../appearance.ts";
import {
  editPersonaYaml,
  personaRefusal,
  personaSetting,
  setDotted,
  writeFailure,
} from "../personas.ts";
import { checkRig, slowRefusal } from "../psd2live.ts";
import { fileResponse } from "../ranges.ts";
import { imageHeaders, localError, localJson, readJson } from "../responses.ts";
import { reinstallSettings } from "../restart.ts";
import type { LocalApp, LocalRequestContext, LocalRouteSpec } from "../router.ts";

// A model is named by its file's hash: a URL never changes what it serves.
const IMMUTABLE = "private, max-age=31536000, immutable";

type Handler<T> = (
  request: Request,
  context: LocalRequestContext,
  id: string,
  target: T,
) => Response | Promise<Response>;

/** A route on persona `:id`, run only for a persona that exists. */
function forPersona(handler: Handler<null>): LocalRouteSpec["handler"] {
  return (request, context) => {
    const id = context.params.id as string;
    return personaRefusal(id) ?? handler(request, context, id, null);
  };
}

const unknownModel = () => localError(404, "unknown-model", "She has no model by that id");

/** A route on her model `:model`, run only for one of hers. */
function forModel(handler: Handler<CharacterModel>): LocalRouteSpec["handler"] {
  return forPersona((request, context, id) => {
    const raw = context.params.model as string;
    if (!isModelId(raw)) return localError(400, "bad-request", "A model id is a lowercase slug");
    const model = readModel(id, raw);
    return model === null ? unknownModel() : handler(request, context, id, model);
  });
}

function callRefusal(app: LocalApp): Response | null {
  return app.activeCalls() > 0
    ? localError(409, "call-active", "Importing a model waits until the call ends")
    : null;
}

/** An upload's bytes and what the runtime read of them, or the answer to give instead. */
async function readUpload(
  app: LocalApp,
  request: Request,
): Promise<{ bytes: Uint8Array; inventory: ModelInventory } | Response> {
  const busy = callRefusal(app);
  if (busy !== null) return busy;
  const bytes = await readBytes(request, MAX_MODEL_BYTES);
  if (bytes === null) return localError(413, "payload-too-large", "A model is 200 MiB at most");
  if (bytes.byteLength === 0) return localError(400, "bad-request", "The file is empty");
  const slow = await slowRefusal(bytes);
  if (slow !== null) return localError(400, slow.code, slow.message);
  // Loading a rig holds the server for a while, which a call that started meanwhile would hear.
  const started = callRefusal(app);
  if (started !== null) return started;
  const checked = checkRig(bytes);
  if (!checked.ok) {
    const status = checked.code === "unsupported-media-type" ? 415 : 400;
    return localError(status, checked.code, checked.message);
  }
  return { bytes, inventory: checked.inventory };
}

export function appearanceRoutes(app: LocalApp): LocalRouteSpec[] {
  return [
    {
      route: "GET /api/local/personas/:id/models",
      handler: forPersona((_request, _context, id) => {
        const active = activeModel(id, personaSetting(id, "APPEARANCE_MODEL"));
        return localJson(200, { active: active?.id ?? null, models: listModels(id) });
      }),
    },
    {
      route: "POST /api/local/personas/:id/models",
      handler: forPersona(async (request, { url }, id) => {
        const upload = await readUpload(app, request);
        if (upload instanceof Response) return upload;
        const filename = url.searchParams.get("filename");
        try {
          return localJson(201, importModel(id, filename, upload.bytes, upload.inventory));
        } catch (error) {
          return writeFailure(error);
        }
      }),
    },
    {
      route: "PUT /api/local/personas/:id/models/:model/file",
      handler: forModel(async (request, _context, id, model) => {
        const upload = await readUpload(app, request);
        if (upload instanceof Response) return upload;
        // Removed while the file arrived: a write now would bring it back.
        const current = readModel(id, model.id);
        if (current === null) return unknownModel();
        try {
          return localJson(200, replaceRig(id, current, upload.bytes, upload.inventory));
        } catch (error) {
          return writeFailure(error);
        }
      }),
    },
    {
      route: "PATCH /api/local/personas/:id/models/:model",
      handler: forModel(async (request, _context, id, model) => {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const current = readModel(id, model.id);
        if (current === null) return unknownModel();
        const patch = checkPatch(current, body.value);
        if (typeof patch === "string") return localError(400, "bad-request", patch);
        if (Object.keys(patch).length === 0) return localJson(200, current);
        try {
          return localJson(200, patchModel(id, current, patch));
        } catch (error) {
          return writeFailure(error);
        }
      }),
    },
    {
      route: "DELETE /api/local/personas/:id/models/:model",
      handler: forModel((_request, _context, id, model) => {
        if (!deleteModel(id, model.id)) {
          return localError(403, "forbidden", "Eidolon deletes only in its data home");
        }
        // Only her own: the environment's value is the default for every persona.
        const setting = readSettingsLayers(id).values.get("APPEARANCE_MODEL");
        if (setting?.source === "persona" && setting.value === model.id) {
          try {
            editPersonaYaml(id, (tree) => setDotted(tree, "appearance.model", null));
          } catch (error) {
            return writeFailure(error);
          }
          reinstallSettings(app);
        }
        return localJson(200, { ok: true });
      }),
    },
    {
      route: "GET /api/local/personas/:id/models/:model/file",
      cache: IMMUTABLE,
      handler: forModel((request, { url }, id, model) => {
        const sha256 = url.searchParams.get("sha256");
        if (sha256 === null) return localError(400, "bad-request", "Name the file by its sha256");
        if (sha256 !== model.sha256) return localError(404, "not-found", "No such file");
        return fileResponse(
          request,
          rigPath(id, model.id),
          imageHeaders("application/octet-stream"),
        );
      }),
    },
  ];
}
