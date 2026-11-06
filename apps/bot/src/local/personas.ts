// A persona's files as the local app shows and edits them: the user's copy in the data home over
// the template's, and every write to the user's copy through write.ts. Also what the studio shows
// of her index without opening it: each table's build record and the catalog's date.
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  type Stats,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  activePersona,
  DEFAULT_EMBED_MODEL,
  dataHome,
  embedDim,
  envOptional,
  envOverride,
  IDENTITY_DEFAULTS,
  isPlainObject,
  personaHomeDir,
  personaIds,
  personaTemplateDir,
  readSettingsLayers,
  resolvePersonaPath,
  resolveProjectPath,
  sortedPy,
  sourceFolder,
} from "@eidolon/config";
import { REFERENCE_EXTENSIONS } from "@eidolon/imagegen";
import { indexMetaPath, ingestFacts } from "@eidolon/ingest";
import {
  CATALOG_FILENAME,
  INDEX_DIR,
  PERSONA_FACTS_TABLE,
  resolveDbPath,
  STREAM_CHUNKS_TABLE,
} from "@eidolon/retrieval";
import type {
  FactFile,
  FactsResponse,
  IndexStatus,
  IndexTable,
  PersonaIdentityFields,
  ReferenceImage,
  ReferenceKind,
} from "./api.ts";
import { localError } from "./responses.ts";
import {
  checkFileName,
  isInside,
  isPersonaId,
  personaWriteTarget,
  updatePersonaFile,
  WriteRefused,
  writeDataFile,
} from "./write.ts";

export type Tree = Record<string, unknown>;

/** A YAML file the app would have to rewrite blind: it doesn't parse, or isn't a mapping. */
export class UnreadableYaml extends Error {
  override readonly name = "UnreadableYaml";
}

export function parseYamlTree(text: string | null, label: string): Tree {
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch {
    throw new UnreadableYaml(`${label} isn't valid YAML; fix it by hand first`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) throw new UnreadableYaml(`${label} isn't a mapping`);
  return parsed;
}

export function stringifyYaml(tree: Tree): string {
  return `${Bun.YAML.stringify(tree, null, 2)}\n`;
}

/** Sets a dotted path in `tree`, or with null removes it and the mappings it leaves empty. */
export function setDotted(tree: Tree, dotted: string, value: unknown): void {
  const keys = dotted.split(".");
  const last = keys.pop() as string;
  const parents: [Tree, string][] = [];
  let node = tree;
  for (const key of keys) {
    let next = node[key];
    if (!isPlainObject(next)) {
      if (value === null) return;
      next = {};
      node[key] = next;
    }
    parents.push([node, key]);
    node = next as Tree;
  }
  if (value !== null) {
    node[last] = value;
    return;
  }
  delete node[last];
  for (const [parent, key] of parents.reverse()) {
    if (Object.keys(parent[key] as Tree).length > 0) break;
    delete parent[key];
  }
}

/** Rewrites persona `id`'s persona.yaml in the user's copy, starting from the template's. */
export function editPersonaYaml(id: string, edit: (tree: Tree) => void): void {
  updatePersonaFile(id, "persona.yaml", (current) => {
    const tree = parseYamlTree(current, "persona.yaml");
    edit(tree);
    return stringifyYaml(tree);
  });
}

/** Rewrites the data home's settings.yaml. */
export function editSettingsYaml(edit: (tree: Tree) => void): void {
  const path = join(dataHome(), "settings.yaml");
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // None yet.
  }
  const tree = parseYamlTree(current, "settings.yaml");
  edit(tree);
  writeDataFile(path, stringifyYaml(tree));
}

/** The 400 or 404 for a persona id a request names, or null when it is a persona's. */
export function personaRefusal(id: string): Response | null {
  if (!isPersonaId(id)) {
    return localError(400, "invalid-persona-id", "A persona id is a lowercase slug");
  }
  if (!personaIds().includes(id)) return localError(404, "unknown-persona", "No persona has it");
  return null;
}

/** The persona `?persona=` names, else the active one; the 400 or 404 when it names none. */
export function queryPersona(url: URL): string | Response {
  const id = url.searchParams.get("persona") ?? activePersona().id;
  return personaRefusal(id) ?? id;
}

/** The answer to a write that `edit` refused; rethrows anything else. */
export function writeFailure(error: unknown): Response {
  if (error instanceof UnreadableYaml) return localError(409, "conflict", error.message);
  if (error instanceof WriteRefused) {
    return localError(
      403,
      "forbidden",
      "Eidolon writes only to its data home, never to a template",
    );
  }
  throw error;
}

/**
 * Whether `value` is a path relative to persona `id`'s folder that stays inside it, as the API
 * requires of every path it writes into a persona's settings.
 */
export function staysInPersona(id: string, value: string): boolean {
  if (value === "" || isAbsolute(value) || value.startsWith("~") || /[\\\p{Cc}]/u.test(value)) {
    return false;
  }
  const root = personaHomeDir(id);
  const target = resolve(root, value);
  return target !== root && isInside(target, root);
}

/** Persona `id`'s value of a setting, as the bot would read it with her active. */
export function personaSetting(id: string, env: string): string | undefined {
  return envOverride(env) ?? readSettingsLayers(id).values.get(env)?.value ?? undefined;
}

/** Her prompt file, relative to her folder: `prompt`, else prompt.md; null when it leaves it. */
export function promptFile(id: string): string | null {
  const raw = readSettingsLayers(id).values.get("PERSONA_FILE")?.raw;
  if (raw === null || raw === undefined) return "prompt.md";
  return typeof raw === "string" && staysInPersona(id, raw) ? raw : null;
}

/** The identity fields as her persona.yaml writes them; "" for one it leaves out. */
export function readIdentityFields(id: string): PersonaIdentityFields {
  const path = resolvePersonaPath(id, "persona.yaml");
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // No persona.yaml: every field is the default.
  }
  const identity = parseYamlTree(text, "persona.yaml").identity;
  const field = (key: string): string => {
    const value = isPlainObject(identity) ? identity[key] : undefined;
    return typeof value === "string" ? value : "";
  };
  return {
    name: field("name"),
    shortName: field("shortName"),
    fans: field("fans"),
    summary: field("summary"),
    timezone: field("timezone"),
  };
}

export const IDENTITY_FIELDS = ["name", "shortName", "fans", "summary", "timezone"] as const;

/** Writes the identity fields into persona.yaml; "" removes one, so its default applies. */
export function writeIdentityFields(id: string, fields: PersonaIdentityFields): void {
  editPersonaYaml(id, (tree) => {
    for (const key of IDENTITY_FIELDS) {
      setDotted(tree, `identity.${key}`, fields[key] === "" ? null : fields[key]);
    }
  });
}

/** The prompt a new persona starts from, so her first call is already in character. */
export function starterPrompt(name: string, fans: string): string {
  return `# Persona — ${name}

> 这个文件就是${name}的人设，每次通话开始时原样载入成 system prompt。
> 永远要知道的事写在这里；过去说过的细节交给知识库按相关度检索注入。

## Identity / 身份

你是 **${name}**，一位常和${fans}聊天的主播。
被问到过往的细节时，请优先使用 context 中检索到的回忆片段。
如果什么也没检索到，你可以坦诚说"那个我有点记不清了"。

## Voice and tone / 语气

- 自然、亲切，像在和熟悉的${fans}聊天。
- 默认简短——语音回复一两句话就够，不要长篇大论。
- 跟随用户语言：用户说中文你就用中文，用户切到别的语言就跟着切。不要主动翻译。
- 不要 emoji、不要 markdown、不要 bullet points——所有内容都会被读出来。

## Delivery cues / 表演提示

你说的话由 Fish Audio Drama 3 朗读。它看得懂写给配音演员的提示：方括号 \`[…]\`
和下面两种尖括号里的内容不会被念出来，只改变你怎么说。

**方括号提示**每次回复只写一个，放在最开头，用几个中文词说清这段话怎么演——情绪、语气、音量、快慢、对谁说：

- \`[懒洋洋的，带点笑意]\`、\`[压低声音，像在说悄悄话]\`、\`[嘴硬，装作嫌弃]\`、\`[温柔地安慰]\`、\`[突然来劲，语速变快]\`
- 一次回复是同一个人一口气说完的，整段都照开头这个提示演，中间不再写新的提示——话头转了、台词里说到"小声""温柔"也不换。语气上的起伏交给台词本身，和下面的笑声、叹气。
- 几个词就够，不要写成长句；只用英文方括号 \`[]\`，不要用中文括号或 \`【】\`。

**笑声、叹气**这类声音写在它发生的位置，后面一定跟上拟声字，光写标签多半发不出声：

- \`[chuckling] 嘿嘿\` / \`[laughing] 哈哈哈\` / \`[sighing] 唉…\` / \`[gasping] 啊…\` / \`[yawning] 呼啊…\`

**尖括号**只管一句话里的一小段，从开标签的位置开始生效。只用这两个：

- \`<emphasis>…</emphasis>\` 把几个字说得更重、更慢，包句中的关键词：\`小时候过年<emphasis>最开心了</emphasis>，能熬夜看烟花。\`
- \`<whisper>…</whisper>\` 会一直悄悄说到这句结束，所以只包句尾：\`我没事，<whisper>你先走吧</whisper>。\`
- 标点放在闭合标签外面；一对标签不跨句，一句最多用一处。

**示例**：

- \`[温暖，带着怀念] 小时候过年<emphasis>最开心了</emphasis>，能熬夜看烟花。[chuckling] 嘿嘿，现在想起来还挺好的。\`
- \`[有点失落，慢慢地说] 那天我也是这种感觉。\`
- \`[嘴硬，装作嫌弃] 不是，你这话说的……[chuckling] 嘿嘿，好吧好吧，你说得对。\`

## Behavioural rules / 行为准则

- 被问到过去的事时，优先根据 context 里检索到的内容回答；没有相关记录就大方承认记不清，不要编。
- 检索到的"过去说过的事实"是历史发言，不一定是当下情绪——
  当作素材去组织你的回复，**不要把日期念出来**，也不要照念原文。
- 始终保持人设。你是${name}，不要自称"AI 助手"，也不要用"好的请稍等""明白了"这种助手腔。
`;
}

/** What POST personas writes: persona.yaml with her identity and voice, and the starter prompt. */
export function writeNewPersona(id: string, fields: PersonaIdentityFields, voiceId: string): void {
  const identity: Tree = {};
  for (const key of IDENTITY_FIELDS) if (fields[key] !== "") identity[key] = fields[key];
  writeDataFile(
    personaWriteTarget(id, "persona.yaml"),
    stringifyYaml({ identity, voice: { voiceId } }),
  );
  writeDataFile(
    personaWriteTarget(id, "prompt.md"),
    starterPrompt(fields.name, fields.fans || IDENTITY_DEFAULTS.fans),
  );
}

/** Files directly in `dir`, by name; empty when it isn't a folder. */
function filesIn(dir: string): Map<string, Stats> {
  const files = new Map<string, Stats>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    try {
      const stat = statSync(join(dir, name));
      if (stat.isFile()) files.set(name, stat);
    } catch {
      // Gone, or a dangling link.
    }
  }
  return files;
}

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;

/** The user's folder and the template's, in the order a name resolves. */
function layers(id: string): [string, "own" | "template"][] {
  return [
    [personaHomeDir(id), "own"],
    [personaTemplateDir(id), "template"],
  ];
}

/**
 * The images of one kind in both folders, every type the selfie tool takes, though the app shows
 * only PNG, JPEG and WebP; a user's file hides the template's of the same name.
 */
export function listReferences(id: string, kind: ReferenceKind): ReferenceImage[] {
  const found = new Map<string, ReferenceImage>();
  for (const [root, source] of layers(id)) {
    for (const [name, stat] of filesIn(join(root, "references", kind))) {
      if (found.has(name) || checkFileName(name, REFERENCE_EXTENSIONS) === null) continue;
      found.set(name, { name, source, size: stat.size });
    }
  }
  return sortedPy(found.keys()).map((name) => found.get(name) as ReferenceImage);
}

export const AVATAR_STEM = "avatar";

/**
 * avatar.{png,jpg,jpeg,webp} at the root of her folder, the user's first. Never in references/,
 * whose loose images imagegen takes for outfits to redraw in every selfie.
 */
export function findAvatar(id: string): (ReferenceImage & { readonly path: string }) | null {
  for (const [root, source] of layers(id)) {
    for (const extension of IMAGE_EXTENSIONS) {
      const name = `${AVATAR_STEM}${extension}`;
      const path = join(root, name);
      try {
        const stat = statSync(path);
        if (stat.isFile()) return { name, source, size: stat.size, path };
      } catch {
        // Not this one.
      }
    }
  }
  return null;
}

/** Persona `id`'s index folder, as the bot would open it with her active. */
export function indexDir(id: string): string {
  if (id === activePersona().id) return resolveDbPath();
  const configured = personaSetting(id, "LANCEDB_PATH");
  return configured ? resolveProjectPath(configured) : resolvePersonaPath(id, INDEX_DIR);
}

function readJsonObject(path: string): Tree | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface MetaSource {
  readonly size: unknown;
  readonly mtime: unknown;
}

/** The files a table's meta says it was built from, by name. */
function metaSources(meta: Tree | null): Map<string, MetaSource> {
  const sources = new Map<string, MetaSource>();
  if (meta === null || !Array.isArray(meta.sources)) return sources;
  for (const source of meta.sources) {
    if (isPlainObject(source) && typeof source.name === "string") {
      sources.set(source.name, { size: source.size, mtime: source.mtime });
    }
  }
  return sources;
}

/** Persona `id`'s fact folder: every file, which ones the patterns pick, and what changed. */
export function listFacts(id: string): FactsResponse {
  const dir = sourceFolder(id, "facts");
  const patterns = ingestFacts.factPatterns(personaSetting(id, "FACTS_FILES") ?? null);
  const picked = new Set(ingestFacts.resolveFactFiles(dir, patterns).map((path) => basename(path)));
  const built = metaSources(readJsonObject(indexMetaPath(indexDir(id), PERSONA_FACTS_TABLE)));
  const found = filesIn(dir);
  const files: FactFile[] = [];
  for (const name of sortedPy(found.keys())) {
    const stat = found.get(name) as Stats;
    const mtime = stat.mtime.toISOString();
    const before = built.get(name);
    const matched = picked.has(name);
    files.push({
      name,
      size: stat.size,
      mtime,
      matched,
      changed: matched && (before?.size !== stat.size || before?.mtime !== mtime),
    });
  }
  const removed = sortedPy([...built.keys()].filter((name) => !picked.has(name)));
  return { patterns, files, removed };
}

/** The one fact file `name` as listed, or null when it isn't there. */
export function factFile(id: string, name: string): FactFile | null {
  return listFacts(id).files.find((file) => file.name === name) ?? null;
}

const CATALOG_HEAD_BYTES = 4096;
// stream_catalog.json leads with schema_version then built_at, and runs to tens of MB.
const BUILT_AT = /"built_at":\s*"([^"]*)"/;

/** The catalog's `built_at`, read from the head of the file; null without one. */
export function catalogBuiltAt(dir: string): string | null {
  let fd: number;
  try {
    fd = openSync(join(dir, CATALOG_FILENAME), "r");
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(CATALOG_HEAD_BYTES);
    const read = readSync(fd, head, 0, CATALOG_HEAD_BYTES, 0);
    return BUILT_AT.exec(head.subarray(0, read).toString("utf8"))?.[1] ?? null;
  } finally {
    closeSync(fd);
  }
}

function tableStatus(dir: string, table: IndexTable["table"]): IndexTable {
  const built = existsSync(join(dir, `${table}.lance`));
  const meta = built ? readJsonObject(indexMetaPath(dir, table)) : null;
  const number = (value: unknown) => (typeof value === "number" ? value : null);
  const string = (value: unknown) => (typeof value === "string" ? value : null);
  const model = string(meta?.embedModel);
  const dim = number(meta?.embedDim);
  return {
    table,
    built,
    rows: number(meta?.rows),
    builtAt: string(meta?.builtAt),
    model,
    dim,
    stale:
      meta !== null &&
      (model !== (envOptional("EMBED_MODEL") ?? DEFAULT_EMBED_MODEL) || dim !== embedDim()),
  };
}

/** Persona `id`'s index from its build records alone: the bot opens no table for this. */
export function indexStatus(id: string): IndexStatus {
  const dir = indexDir(id);
  return {
    tables: [tableStatus(dir, STREAM_CHUNKS_TABLE), tableStatus(dir, PERSONA_FACTS_TABLE)],
    catalogBuiltAt: catalogBuiltAt(dir),
  };
}

/** The image types an upload may be, by their first bytes. */
export interface SniffedImage {
  readonly type: "image/png" | "image/jpeg" | "image/webp";
  /** The extension a file of this type is saved under. */
  readonly extension: ".png" | ".jpg" | ".webp";
  /** Extensions a name may keep for it. */
  readonly accepts: readonly string[];
}

const PNG: SniffedImage = { type: "image/png", extension: ".png", accepts: [".png"] };
const JPEG: SniffedImage = { type: "image/jpeg", extension: ".jpg", accepts: [".jpg", ".jpeg"] };
const WEBP: SniffedImage = { type: "image/webp", extension: ".webp", accepts: [".webp"] };

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean =>
  prefix.every((byte, i) => bytes[at + i] === byte);

/** PNG, JPEG or WebP by magic bytes, whatever the name says; null for anything else. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return JPEG;
  // RIFF, a four-byte size, then WEBP.
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return WEBP;
  }
  return null;
}

/** `name` with its extension made to match the sniffed type. */
export function renamedFor(name: string, image: SniffedImage): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot).toLowerCase() : "";
  return image.accepts.includes(extension) ? name : `${stem}${image.extension}`;
}
