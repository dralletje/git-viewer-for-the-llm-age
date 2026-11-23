import type { Node } from "web-tree-sitter";
import { patternNames } from "#/local-exports.ts";

/** Functions: their parameters (and a function expression's own name) are in their scope. */
const functionTypes = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "function",
  "generator_function",
  "arrow_function",
  "method_definition",
]);

/** Nodes that start a scope: the file, functions, blocks, and the statements that declare a name for their body. */
const scopeTypes = new Set([...functionTypes, "program", "statement_block", "class_body", "for_statement", "for_in_statement", "catch_clause", "switch_body"]);

export function isScope(node: Node): boolean {
  return scopeTypes.has(node.type);
}

/**
 * The names a scope declares: a function's parameters, a catch's error,
 * a for loop's variable, and the declarations directly in it (not in a
 * scope inside it): `let`, `const`, functions, classes, enums and imports.
 * A `var` belongs to the whole function (or file) it's in, wherever in it
 * it's written: blocks and loops inside included, other functions not.
 */
export function declaredNames(scope: Node): Set<string> {
  const names = new Set<string>();

  if (functionTypes.has(scope.type)) {
    if (scope.type === "function_expression" || scope.type === "function" || scope.type === "generator_function") {
      const name = scope.childForFieldName("name");
      if (name !== null) names.add(name.text);
    }
    const parameter = scope.childForFieldName("parameter");
    if (parameter !== null) for (const name of patternNames(parameter)) names.add(name);
    for (const parameter of scope.childForFieldName("parameters")?.namedChildren ?? []) {
      if (parameter === null) continue;
      // TypeScript wraps each one (`required_parameter pattern: ...`); JavaScript doesn't.
      const pattern = parameter.childForFieldName("pattern") ?? parameter;
      for (const name of patternNames(pattern)) names.add(name);
    }
    collectVars(scope.childForFieldName("body"), names);
    return names;
  }
  if (scope.type === "catch_clause") {
    for (const name of patternNames(scope.childForFieldName("parameter"))) names.add(name);
    return names;
  }
  if (scope.type === "for_in_statement") {
    // `for (const x of xs)` declares x for the loop; `for (var x ...)` for the function; `for (x of xs)` nothing.
    const kind = scope.childForFieldName("kind")?.text;
    if (kind === "let" || kind === "const") for (const name of patternNames(scope.childForFieldName("left"))) names.add(name);
    return names;
  }
  if (scope.type === "for_statement") {
    collect(scope.childForFieldName("initializer"), names);
    return names;
  }
  for (const child of scope.namedChildren) collect(child, names);
  if (scope.type === "program") collectVars(scope, names);
  return names;
}

/** The `var`s in a function's body (or a file), in its blocks and loops too, not in the functions inside it. */
function collectVars(node: Node | null, names: Set<string>): void {
  if (node === null) return;
  if (node.type === "variable_declaration") {
    for (const declarator of node.namedChildren) {
      if (declarator?.type === "variable_declarator") for (const name of patternNames(declarator.childForFieldName("name"))) names.add(name);
    }
  }
  if (node.type === "for_in_statement" && node.childForFieldName("kind")?.text === "var") {
    for (const name of patternNames(node.childForFieldName("left"))) names.add(name);
  }
  for (const child of node.namedChildren) {
    if (child !== null && !functionTypes.has(child.type)) collectVars(child, names);
  }
}

/** Declarations in `node`, without going into a scope inside it (whose own name, for a function or class, does belong here). */
function collect(node: Node | null, names: Set<string>): void {
  if (node === null) return;
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "class_declaration":
    case "abstract_class_declaration":
    case "enum_declaration": {
      const name = node.childForFieldName("name");
      if (name !== null) names.add(name.text);
      return;
    }
    case "variable_declarator":
      for (const name of patternNames(node.childForFieldName("name"))) names.add(name);
      return;
    // A `var` belongs to its function, not this block (see collectVars).
    case "variable_declaration":
      return;
    // `declare const fetch: ...` describes the global for the type checker: it doesn't declare another.
    case "ambient_declaration":
      return;
    // `import fs = require("fs")`.
    case "import_require_clause": {
      const name = node.namedChildren.find((child) => child?.type === "identifier");
      if (name !== undefined && name !== null) names.add(name.text);
      return;
    }
    case "import_clause":
      for (const part of node.namedChildren) {
        if (part?.type === "identifier") names.add(part.text);
        if (part?.type === "namespace_import") for (const name of part.namedChildren) if (name?.type === "identifier") names.add(name.text);
        if (part?.type === "named_imports") {
          for (const specifier of part.namedChildren) {
            const name = specifier?.childForFieldName("alias") ?? specifier?.childForFieldName("name");
            if (name !== null && name !== undefined) names.add(name.text);
          }
        }
      }
      return;
  }
  if (scopeTypes.has(node.type)) return;
  for (const child of node.namedChildren) collect(child, names);
}
