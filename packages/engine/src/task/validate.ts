// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/ai/src/utils/validation.ts@ac78a60
//
// A tool call's arguments checked against its schema before it runs, coerced first as pi-schema's
// parse() coerces a model's loose JSON: "42" for a number, one value for an array, null for an
// omitted optional property.
import { isPlainObject } from "@eidolon/config";
import type { ToolSchema } from "@eidolon/core";

type Schema = Readonly<Record<string, unknown>>;

interface Issue {
  readonly path: string;
  readonly message: string;
}

function typesOf(schema: Schema): string[] {
  if (typeof schema.type === "string") return [schema.type];
  return Array.isArray(schema.type)
    ? schema.type.filter((type): type is string => typeof type === "string")
    : [];
}

function matches(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    default:
      return true;
  }
}

/**
 * `value` as `type`, or undefined when it can't be. `sole`: no other type is allowed, so a string
 * schema takes null as "null" and a boolean one takes "1" and "0", as TypeBox's conversion does.
 */
function converted(value: unknown, type: string, sole: boolean): unknown {
  switch (type) {
    case "number":
    case "integer": {
      let number: number | undefined;
      if (typeof value === "number") number = value;
      else if (typeof value === "boolean") number = value ? 1 : 0;
      else if (value === null) number = 0;
      else if (typeof value === "string" && value.trim() !== "") number = Number(value);
      if (number === undefined || !Number.isFinite(number)) return undefined;
      return type === "integer" ? Math.trunc(number) : number;
    }
    case "boolean": {
      if (value === null) return false;
      if (value === 1 || value === 0) return value === 1;
      if (typeof value !== "string") return undefined;
      const lower = value.toLowerCase();
      if (lower === "true" || (sole && value === "1")) return true;
      if (lower === "false" || (sole && value === "0")) return false;
      return undefined;
    }
    case "string":
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return value === null && sole ? "null" : undefined;
    case "null":
      return value === "" ||
        value === 0 ||
        value === false ||
        (typeof value === "string" && value.toLowerCase() === "null")
        ? null
        : undefined;
    case "array":
      return value === undefined ? undefined : [value];
    default:
      return undefined;
  }
}

function branchesOf(schema: Schema): Schema[][] {
  return [schema.anyOf, schema.oneOf]
    .filter(Array.isArray)
    .map((branches) => branches.filter(isPlainObject));
}

function coerce(value: unknown, schema: Schema): unknown {
  let next = value;
  for (const branches of branchesOf(schema)) {
    if (branches.some((branch) => valid(next, branch))) continue;
    for (const branch of branches) {
      const coerced = coerce(next, branch);
      if (valid(coerced, branch)) {
        next = coerced;
        break;
      }
    }
  }
  const types = typesOf(schema);
  if (types.length > 0 && !types.some((type) => matches(next, type))) {
    for (const type of types) {
      const candidate = converted(next, type, types.length === 1);
      if (candidate !== undefined && matches(candidate, type)) {
        next = candidate;
        break;
      }
    }
  }
  if (isPlainObject(next) && isPlainObject(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    const object: Record<string, unknown> = { ...next };
    for (const [key, property] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(object, key) || !isPlainObject(property)) continue;
      if (object[key] === null && !required.includes(key) && !valid(null, property)) {
        delete object[key];
      } else {
        object[key] = coerce(object[key], property);
      }
    }
    next = object;
  }
  const { items } = schema;
  if (Array.isArray(next) && isPlainObject(items)) next = next.map((item) => coerce(item, items));
  return next;
}

function at(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** pi-schema's name for a value's type. */
function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return typeof value;
}

function check(value: unknown, schema: Schema, path: string, issues: Issue[]): void {
  const types = typesOf(schema);
  if (types.length > 0 && !types.some((type) => matches(value, type))) {
    issues.push({ path, message: `expected ${types.join(" or ")}, got ${typeName(value)}` });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => same(option, value))) {
    issues.push({ path, message: `expected one of ${JSON.stringify(schema.enum)}` });
  }
  if (Object.hasOwn(schema, "const") && !same(schema.const, value)) {
    issues.push({ path, message: `expected ${JSON.stringify(schema.const)}` });
  }
  if (isPlainObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && value[key] === undefined) {
        issues.push({ path: at(path, key), message: "missing" });
      }
    }
    if (isPlainObject(schema.properties)) {
      for (const [key, property] of Object.entries(schema.properties)) {
        if (value[key] !== undefined && isPlainObject(property)) {
          check(value[key], property, at(path, key), issues);
        }
      }
    }
  }
  const { items } = schema;
  if (Array.isArray(value) && isPlainObject(items)) {
    for (const [index, item] of value.entries())
      check(item, items, at(path, String(index)), issues);
  }
  for (const branches of branchesOf(schema)) {
    if (!branches.some((branch) => valid(value, branch))) {
      issues.push({ path, message: "matches none of the allowed schemas" });
    }
  }
}

function valid(value: unknown, schema: Schema): boolean {
  const issues: Issue[] = [];
  check(value, schema, "", issues);
  return issues.length === 0;
}

/**
 * `args` as `schema` takes them: a coerced copy, so a tool that changes its arguments never changes
 * the call in the transcript. Throws pi's message, each issue and then the arguments received.
 */
export function validateToolArguments(
  schema: ToolSchema,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const root: Schema = { type: "object", properties: schema.properties, required: schema.required };
  const value = coerce(structuredClone(args), root);
  const issues: Issue[] = [];
  check(value, root, "", issues);
  if (issues.length === 0) return value as Record<string, unknown>;
  const listed = issues.map(({ path, message }) => `  - ${path || "root"}: ${message}`).join("\n");
  throw new Error(
    `Validation failed for tool "${schema.name}":\n${listed}\n\n` +
      `Received arguments:\n${JSON.stringify(args, null, 2)}`,
  );
}
