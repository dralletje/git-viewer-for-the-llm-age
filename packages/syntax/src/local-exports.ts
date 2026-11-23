import type { Node } from "web-tree-sitter";

/** The names a file exports from its own code: values ("default" for a default export), and types apart. */
export type LocalExports = { values: Array<string>; types: Array<string> };

/** Declarations that only exist for the type checker. */
const typeDeclarations = new Set(["type_alias_declaration", "interface_declaration"]);

/**
 * The names a file exports from its own code, not the ones it passes on
 * from another module (`export ... from`, which are re-exports among its
 * imports). Null when the file uses CommonJS (`module.exports`,
 * `exports.x`, `export =`): which names it exports isn't known from its
 * syntax.
 */
export function localExportNames(root: Node): LocalExports | null {
  const values: Array<string> = [];
  const types: Array<string> = [];
  let commonjs = false;

  for (const statement of root.namedChildren) {
    if (statement === null) continue;
    if (statement.type === "expression_statement" && /^\s*(module\.exports|exports\.)/.test(statement.text)) commonjs = true;
    if (statement.type !== "export_statement" || statement.childForFieldName("source") !== null) continue;

    const declaration = statement.childForFieldName("declaration");
    if (statement.children.some((child) => child?.type === "default")) {
      values.push("default");
    } else if (declaration !== null) {
      if (declaration.type === "lexical_declaration" || declaration.type === "variable_declaration") {
        for (const declarator of declaration.namedChildren) {
          if (declarator?.type === "variable_declarator") values.push(...patternNames(declarator.childForFieldName("name")));
        }
      } else {
        const name = declaration.childForFieldName("name")?.text;
        if (name !== undefined) (typeDeclarations.has(declaration.type) ? types : values).push(name);
      }
    } else {
      const clause = statement.namedChildren.find((child) => child?.type === "export_clause");
      if (clause === undefined || clause === null) {
        // `export = value`: TypeScript's CommonJS export.
        commonjs = true;
        continue;
      }
      const typeOnly = statement.children.some((child) => child?.type === "type");
      for (const specifier of clause.namedChildren) {
        if (specifier?.type !== "export_specifier") continue;
        const name = specifier.childForFieldName("alias") ?? specifier.childForFieldName("name");
        if (name === null) continue;
        (typeOnly || specifier.children.some((token) => token?.type === "type") ? types : values).push(name.text);
      }
    }
  }
  return commonjs ? null : { values, types };
}

/** The names a binding pattern declares: `a`, `{ a, b: [c] }`, `{ a = 1 }`, `...rest`. */
export function patternNames(node: Node | null): Array<string> {
  if (node === null) return [];
  switch (node.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      return [node.text];
    case "pair_pattern":
      return patternNames(node.childForFieldName("value"));
    case "assignment_pattern":
    case "object_assignment_pattern":
      return patternNames(node.childForFieldName("left"));
    case "object_pattern":
    case "array_pattern":
    case "rest_pattern":
      return node.namedChildren.flatMap((child) => patternNames(child));
    default:
      return [];
  }
}
