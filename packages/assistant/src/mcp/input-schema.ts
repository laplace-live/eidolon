// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/mcp/src/input-schema.ts@ac78a60

/**
 * The tool's input schema as an object schema. Tool parameters must be objects, MCP servers may
 * omit `type`, and some providers reject object schemas without `properties`. Other keywords are
 * kept.
 */
export function normalizeMcpInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    ...schema,
    type: schema.type ?? "object",
    ...(schema.properties === undefined ? { properties: {} } : {}),
  };
}
