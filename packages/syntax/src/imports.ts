import type { Node } from "web-tree-sitter";

export type ImportBinding = {
  /** The exported name it takes: a name, "default", or "*" for the whole module. */
  imported: string;
  /** The name it gets here (for a re-export: the name it is exported as). */
  local: string;
  /** `import { type A }`, `export { type A } from`: this name only, for types. */
  typeOnly: boolean;
};

/** One place a file pulls in another module. */
export type Import = {
  kind: "import" | "re-export" | "require" | "dynamic-import";
  /** The module specifier, as written: "react", "./utils.ts", "node:fs". */
  source: string;
  /** `import type ...` / `export type ... from`: gone after compiling. */
  typeOnly: boolean;
  /** Empty for `import "./polyfill"`, `require("x")` and `import("x")`. */
  bindings: Array<ImportBinding>;
  /** 1-based line of the statement. */
  line: number;
};

/**
 * Every import in a TS/TSX/JS tree: `import` statements (also `import x =
 * require()`), `export ... from`, `require("x")` and `import("x")` calls with
 * a plain string. A specifier built at runtime (`require(name)`) isn't one.
 */
export function extractImports(root: Node): Array<Import> {
  const imports: Array<Import> = [];

  const visit = (node: Node) => {
    if (node.type === "import_statement") {
      imports.push(importStatement(node));
      return;
    }
    if (node.type === "export_statement" && node.childForFieldName("source") !== null) {
      imports.push(reExport(node));
      return;
    }
    if (node.type === "call_expression") {
      const call = importCall(node);
      if (call !== null) imports.push(call);
    }
    for (const child of node.namedChildren) {
      if (child !== null) visit(child);
    }
  };
  visit(root);

  return imports;
}

/** One `import` statement (also TypeScript's `import x = require()`). */
export function importStatement(node: Node): Import {
  const typeOnly = node.children.some((child) => child?.type === "type");
  const bindings: Array<ImportBinding> = [];
  let source = stringValue(node.childForFieldName("source"));

  for (const child of node.namedChildren) {
    if (child?.type === "import_clause") {
      for (const part of child.namedChildren) {
        if (part === null) continue;
        if (part.type === "identifier") {
          bindings.push({ imported: "default", local: part.text, typeOnly: false });
        } else if (part.type === "namespace_import") {
          const name = part.namedChildren.find((name) => name?.type === "identifier");
          bindings.push({ imported: "*", local: name?.text ?? "*", typeOnly: false });
        } else if (part.type === "named_imports") {
          for (const specifier of part.namedChildren) {
            if (specifier?.type !== "import_specifier") continue;
            const name = specifier.childForFieldName("name")?.text ?? "";
            const alias = specifier.childForFieldName("alias")?.text;
            bindings.push({ imported: name, local: alias ?? name, typeOnly: specifier.children.some((token) => token?.type === "type") });
          }
        }
      }
    }
    // TypeScript's `import fs = require("fs")`.
    if (child?.type === "import_require_clause") {
      const name = child.namedChildren.find((name) => name?.type === "identifier");
      bindings.push({ imported: "*", local: name?.text ?? "*", typeOnly: false });
      source = stringValue(child.childForFieldName("source"));
    }
  }

  return { kind: "import", source, typeOnly, bindings, line: node.startPosition.row + 1 };
}

function reExport(node: Node): Import {
  const typeOnly = node.children.some((child) => child?.type === "type");
  const bindings: Array<ImportBinding> = [];

  for (const child of node.namedChildren) {
    if (child?.type === "export_clause") {
      for (const specifier of child.namedChildren) {
        if (specifier?.type !== "export_specifier") continue;
        const name = specifier.childForFieldName("name")?.text ?? "";
        const alias = specifier.childForFieldName("alias")?.text;
        bindings.push({ imported: name, local: alias ?? name, typeOnly: specifier.children.some((token) => token?.type === "type") });
      }
    }
    // `export * as name from "x"`.
    if (child?.type === "namespace_export") {
      bindings.push({ imported: "*", local: child.namedChildren[0]?.text ?? "*", typeOnly: false });
    }
  }
  // `export * from "x"`: everything, under the same names.
  if (bindings.length === 0 && node.children.some((child) => child?.type === "*")) {
    bindings.push({ imported: "*", local: "*", typeOnly: false });
  }

  return {
    kind: "re-export",
    source: stringValue(node.childForFieldName("source")),
    typeOnly,
    bindings,
    line: node.startPosition.row + 1,
  };
}

function importCall(node: Node): Import | null {
  const callee = node.childForFieldName("function");
  const argument = node.childForFieldName("arguments")?.namedChildren[0];
  if (callee === null || argument === null || argument === undefined || argument.type !== "string") return null;

  let kind: Import["kind"];
  if (callee.type === "import") {
    kind = "dynamic-import";
  } else if (callee.type === "identifier" && callee.text === "require") {
    kind = "require";
  } else {
    return null;
  }
  return { kind, source: stringValue(argument), typeOnly: false, bindings: [], line: node.startPosition.row + 1 };
}

/** The text inside a string literal's quotes. */
function stringValue(node: Node | null): string {
  if (node === null) return "";
  return node.text.slice(1, -1);
}
