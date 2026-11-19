// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/extensions/mcp/tools.ts@ac78a60
//
// An MCP tool's input schema with its local references inlined, walked as pi's relocateSchema
// walks one. A task's minds send only a tool's `properties` and `required`, so a top-level `$defs`
// would be dropped and every `$ref` into it would dangle; FastMCP and other Pydantic-built servers
// write their nested models that way.
import { isPlainObject } from "@eidolon/config";

/** How many references deep one reference is followed. */
const MAX_DEPTH = 10;
/**
 * How many references one schema inlines: a schema that reuses a model at every level grows past
 * any tool budget long before this.
 */
const MAX_EXPANSIONS = 500;

const RECURSIVE = "(recursive: see the server's schema)";
const TOO_DEEP = "(nested too deep: see the server's schema)";

/** Keywords whose values are data, so a `$ref` key in them is not a reference. */
const DATA_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default", "examples"]);
/** Keywords whose values map names to schemas, so their keys are names, not keywords. */
const MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
]);
/** Only reference targets and metadata: nothing left refers to them once references are inlined. */
const DROPPED: ReadonlySet<string> = new Set(["$defs", "definitions", "$schema", "$id"]);

type Schema = Record<string, unknown>;

/** The value at a local reference (`#`, `#/$defs/Item`) of `root`, or undefined. */
function target(root: Schema, ref: string): unknown {
  const fragment = ref.slice(1);
  if (fragment === "") return root;
  if (!fragment.startsWith("/")) return undefined;
  let node: unknown = root;
  for (const raw of fragment.slice(1).split("/")) {
    let token = raw;
    try {
      token = decodeURIComponent(raw);
    } catch {}
    token = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(node)) node = node[Number(token)];
    else if (isPlainObject(node) && Object.hasOwn(node, token)) node = node[token];
    else return undefined;
  }
  return node;
}

/** A reference's schema with the keywords beside its `$ref`, which apply too. */
function merged(inlined: Schema, siblings: Schema): Schema {
  const schema = { ...inlined, ...siblings };
  if (isPlainObject(inlined.properties) && isPlainObject(siblings.properties)) {
    schema.properties = { ...inlined.properties, ...siblings.properties };
  }
  if (Array.isArray(inlined.required) && Array.isArray(siblings.required)) {
    schema.required = [...new Set([...inlined.required, ...siblings.required])];
  }
  return schema;
}

/**
 * `schema` with every local reference replaced by what it points at, at most 10 deep. A reference
 * back to a schema it is inside becomes a note that it recurses; one that isn't local is dropped.
 */
export function inlineSchemaRefs(schema: Schema): Schema {
  let expansions = 0;
  const walk = (node: unknown, refs: readonly string[]): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, refs));
    if (!isPlainObject(node)) return node;
    const { $ref: ref, ...rest } = node;
    const siblings = walkKeywords(rest, refs);
    if (typeof ref !== "string" || !ref.startsWith("#")) return siblings;
    if (refs.includes(ref)) return { description: RECURSIVE, ...siblings };
    if (refs.length > MAX_DEPTH || ++expansions > MAX_EXPANSIONS) {
      return { description: TOO_DEEP, ...siblings };
    }
    const found = target(schema, ref);
    if (!isPlainObject(found)) return siblings;
    return merged(walk(found, [...refs, ref]) as Schema, siblings);
  };
  const walkKeywords = (node: Schema, refs: readonly string[]): Schema => {
    const out: Schema = {};
    for (const [key, value] of Object.entries(node)) {
      if (DROPPED.has(key)) continue;
      if (DATA_KEYWORDS.has(key)) out[key] = value;
      else if (MAP_KEYWORDS.has(key) && isPlainObject(value)) {
        out[key] = Object.fromEntries(
          Object.entries(value).map(([name, subschema]) => [name, walk(subschema, refs)]),
        );
      } else out[key] = walk(value, refs);
    }
    return out;
  };
  // The root counts as a reference already followed, so `#` inside it is recursive at once.
  return walk(schema, ["#"]) as Schema;
}
