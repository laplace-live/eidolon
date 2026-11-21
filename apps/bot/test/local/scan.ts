// The import scan the boundary tests share: what a source file loads once TypeScript erases its types.
import { readFileSync } from "node:fs";
import { parseAst } from "vitest/node";

interface AstNode {
  readonly type: string;
  readonly [field: string]: unknown;
}

function literal(node: unknown): string | null {
  const value = (node as AstNode | null)?.value;
  return (node as AstNode | null)?.type === "Literal" && typeof value === "string" ? value : null;
}

/**
 * Every specifier `file` loads once its types are erased, in source order: imports, re-exports,
 * `import()` and `require()`, never a type's `import("…")`. Only `import type` and `export type`
 * are erased: under verbatimModuleSyntax, `import { type A } from "a"` still loads "a", in Node's
 * type stripping and in Vite's bundles alike.
 */
export function scan(file: string): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const ast = node as AstNode;
    switch (ast.type) {
      case "ImportDeclaration":
        if (ast.importKind !== "type") found.push(literal(ast.source) as string);
        return;
      case "ExportNamedDeclaration":
        if (ast.source !== null && ast.exportKind !== "type") {
          found.push(literal(ast.source) as string);
        }
        break;
      case "ExportAllDeclaration":
        if (ast.exportKind !== "type") found.push(literal(ast.source) as string);
        return;
      case "ImportExpression": {
        const source = literal(ast.source);
        if (source !== null) found.push(source);
        break;
      }
      case "CallExpression": {
        const callee = ast.callee as AstNode;
        const source = literal((ast.arguments as unknown[])[0]);
        if (callee.type === "Identifier" && callee.name === "require" && source !== null) {
          found.push(source);
        }
        break;
      }
      case "TSImportType":
        return;
    }
    for (const [field, value] of Object.entries(ast)) if (field !== "type") visit(value);
  };
  visit(parseAst(readFileSync(file, "utf8"), { lang: "ts", sourceType: "module" }).body);
  return found;
}
