import type { Node } from "web-tree-sitter";
import { importStatement } from "#/imports.ts";

/**
 * A file's top level as a graph: every import binding, declaration and
 * top-level statement is a unit, and a unit points at the top-level names
 * its code uses. What a change reaches is found by following those.
 */
export type TopLevel = {
  units: Array<TopLevelUnit>;
  exports: Array<Export>;
};

export type TopLevelUnit = {
  /** The same thing in another version of the file has the same key. */
  key: string;
  kind: "import" | "declaration" | "statement";
  /** The top-level names it declares: none for a statement. */
  names: Array<string>;
  /** For people: its names, or "line 12". */
  label: string;
  /**
   * The top-level names its code uses. Syntactic: a local variable that
   * shadows a top-level name still counts, so this errs toward "uses".
   */
  references: Array<string>;
  /** `references` without the mentions in types: what its code uses when it runs. */
  runtimeReferences: Array<string>;
  /** Where its code mentions those names: one entry per mention, in order. */
  uses: Array<Use>;
  /**
   * It only exists for the type checker, and is gone after compiling: an
   * interface, a type alias, a `declare`, an overload signature, `import type`.
   */
  typeOnly: boolean;
  /**
   * Its code as tokens, without comments, whitespace, semicolons and
   * trailing commas: equal when only the formatting changed.
   */
  fingerprint: string;
  /**
   * `fingerprint` without types (annotations, `as` and `satisfies`, `!`,
   * type arguments and parameters, `implements`): equal when what runs is.
   * Empty for a unit that's only types.
   */
  runtimeFingerprint: string;
  /** Its comments (the ones right above it too), whitespace collapsed: different when a comment changed. */
  comments: string;
  /** 1-based. */
  line: number;
  /** 1-based, its whole statement: from the comments right above it to its last line. */
  startLine: number;
  endLine: number;
  /**
   * More of its code further down, apart from the rest: a `X.displayName = ...`
   * with other declarations between (see extractTopLevel). Each from the
   * comments right above it to its last line.
   */
  parts: Array<{ startLine: number; endLine: number }>;
};

/**
 * A mention of a top-level name: on `line` (1-based), from `start` to `end`
 * (string offsets in that line). `inType`: in a type, so not used when the code runs.
 */
export type Use = { name: string; line: number; start: number; end: number; inType: boolean };

export type ExportKind =
  | "function"
  | "class"
  | "variable"
  | "type"
  | "interface"
  | "enum"
  | "namespace"
  /** `export default <expression>`, `export = x`. */
  | "value"
  /** `export { a as b }`: a name declared elsewhere in the file. */
  | "local"
  /** `export { x } from "y"`, `export * from "y"`. */
  | "re-export"
  /** `module.exports = ...`, `exports.name = ...`. */
  | "commonjs";

/** One name a file makes available to others. */
export type Export = {
  /** As other files import it: "greet", "default", or "*" for `export * from`. */
  name: string;
  kind: ExportKind;
  /** Only exists as a type: an interface, a type alias, `export type { X }`. */
  typeOnly: boolean;
  /**
   * The part other files program against, whitespace collapsed: a
   * function's type parameters, parameters and return type, a class's
   * `extends`/`implements`, a variable's type annotation, a type's whole
   * declaration, the module a re-export comes from.
   */
  signature: string | null;
  /** 1-based line of the statement. */
  line: number;
  /** The unit (index in `units`) whose code this export is; null when `export { a }` names nothing declared here. */
  unit: number | null;
};

export function extractTopLevel(root: Node): TopLevel {
  const units: Array<TopLevelUnit> = [];
  const exports: Array<Export> = [];
  // `export { a as b }`: which export points at which name, resolved at the end.
  const localExports: Array<{ exportIndex: number; local: string }> = [];
  // The first line of the comments right above the current statement (no blank line between).
  let commentsFrom: number | null = null;
  let commentsTo = 0;
  // Those comments' text.
  let commentsAbove: Array<string> = [];
  // Where each line starts in the root's text, to turn a node's offset into
  // a column. The root starts at its first statement, not at the file's start:
  // offsets count from there, and its first line from its column.
  const lineStarts = [0];
  for (let index = root.text.indexOf("\n"); index !== -1; index = root.text.indexOf("\n", index + 1)) lineStarts.push(index + 1);
  const columnOf = (node: Node) => {
    const offset = node.startIndex - root.startIndex;
    const row = node.startPosition.row - root.startPosition.row;
    return row === 0 ? root.startPosition.column + offset : offset - (lineStarts[row] ?? 0);
  };

  const usesIn = (node: Node, typeOnly: boolean) =>
    referencesIn(node).map(({ node: mention, inType }): Use => {
      const start = columnOf(mention);
      return { name: mention.text, line: mention.startPosition.row + 1, start, end: start + (mention.endIndex - mention.startIndex), inType: typeOnly || inType };
    });

  // The declarations since the last statement that runs something, by name:
  // a `X.displayName = ...` after X's is part of X (see below).
  let declaredSince = new Map<string, number>();
  // The unit of the statement before this one (comments aside); null for an import or export list.
  let previousUnit: number | null = null;

  const addUnit = (
    node: Node,
    kind: TopLevelUnit["kind"],
    names: Array<string>,
    key: string,
    label: string,
    typeOnly: boolean,
    fingerprint = fingerprintOf(node, true),
  ) => {
    // An import uses nothing in this file; its statement's other names are its siblings.
    const uses = kind === "import" ? [] : usesIn(node, typeOnly);
    const references = uses.map((use) => use.name);
    const runtimeReferences = uses.filter((use) => !use.inType).map((use) => use.name);
    // An import's fingerprint is what it imports, which is the same with or without types.
    const runtimeFingerprint = typeOnly ? "" : kind === "import" ? fingerprint : fingerprintOf(node, false);
    const line = node.startPosition.row + 1;
    const attached = commentsFrom !== null && commentsTo >= line - 1;
    const startLine = attached && commentsFrom !== null ? commentsFrom : line;
    const comments = [...(attached ? commentsAbove : []), ...commentsIn(node)].map(collapse).join("\n");
    units.push({
      key,
      kind,
      names,
      label,
      references,
      runtimeReferences,
      uses,
      typeOnly,
      fingerprint,
      runtimeFingerprint,
      comments,
      line,
      startLine,
      endLine: node.endPosition.row + 1,
      parts: [],
    });
    return units.length - 1;
  };

  for (const statement of root.namedChildren) {
    if (statement === null) continue;
    if (statement.type === "comment") {
      const from = statement.startPosition.row + 1;
      if (commentsFrom === null || commentsTo < from - 1) {
        commentsFrom = from;
        commentsAbove = [];
      }
      commentsTo = statement.endPosition.row + 1;
      commentsAbove.push(statement.text);
      continue;
    }
    // (A comment run above an earlier statement ends before that statement,
    // so addUnit doesn't count it for this one.)
    const line = statement.startPosition.row + 1;
    const previous: number | null = previousUnit;
    previousUnit = null;

    if (statement.type === "import_statement") {
      const parsed = importStatement(statement);
      if (parsed.bindings.length === 0) {
        addUnit(statement, "import", [], `import:${parsed.source}`, `import "${parsed.source}"`, parsed.typeOnly);
      }
      for (const binding of parsed.bindings) {
        const fingerprint = `${parsed.source} ${binding.imported}${parsed.typeOnly ? " type" : ""}`;
        addUnit(statement, "import", [binding.local], `name:${binding.local}`, binding.local, parsed.typeOnly, fingerprint);
      }
      continue;
    }

    if (statement.type === "export_statement") {
      const isDefault = statement.children.some((child) => child?.type === "default");
      const typeOnlyStatement = statement.children.some((child) => child?.type === "type");
      const source = statement.childForFieldName("source");

      // `export { a, b as c } [from "x"]`, `export * [as ns] from "x"`.
      if (source !== null || statement.namedChildren.some((child) => child?.type === "export_clause")) {
        const from = source === null ? null : source.text.slice(1, -1);
        for (const child of statement.namedChildren) {
          if (child?.type === "export_clause") {
            for (const specifier of child.namedChildren) {
              if (specifier?.type !== "export_specifier") continue;
              const local = specifier.childForFieldName("name")?.text ?? "";
              const name = specifier.childForFieldName("alias")?.text ?? local;
              const typeOnly = typeOnlyStatement || specifier.children.some((part) => part?.type === "type");
              if (from === null) {
                exports.push({ name, kind: "local", typeOnly, signature: null, line, unit: null });
                localExports.push({ exportIndex: exports.length - 1, local });
              } else {
                const unit = addUnit(statement, "import", [], `re-export:${name}:${from}`, `${name} from "${from}"`, typeOnly, `${from} ${local}`);
                exports.push({ name, kind: "re-export", typeOnly, signature: from, line, unit });
              }
            }
          }
          if (child?.type === "namespace_export" && from !== null) {
            const name = child.namedChildren[0]?.text ?? "*";
            const unit = addUnit(statement, "import", [], `re-export:${name}:${from}`, `* as ${name} from "${from}"`, typeOnlyStatement, `${from} *`);
            exports.push({ name, kind: "re-export", typeOnly: typeOnlyStatement, signature: from, line, unit });
          }
        }
        if (from !== null && !statement.namedChildren.some((child) => child?.type === "export_clause" || child?.type === "namespace_export")) {
          const unit = addUnit(statement, "import", [], `re-export:*:${from}`, `* from "${from}"`, typeOnlyStatement, `${from} *`);
          exports.push({ name: "*", kind: "re-export", typeOnly: typeOnlyStatement, signature: from, line, unit });
        }
        continue;
      }

      let declaration = statement.childForFieldName("declaration");
      // `export declare function f(): void`: the declaration inside, which is only a type.
      const ambient = declaration?.type === "ambient_declaration";
      if (declaration?.type === "ambient_declaration") {
        declaration = declaration.namedChildren.find((child) => child !== null && child.type !== "comment") ?? declaration;
      }
      if (declaration !== null && declaration !== undefined) {
        const names = declaredNames(declaration) ?? [];
        const key = names.length > 0 ? `name:${names.join(",")}` : "default";
        const unit = addUnit(statement, "declaration", names, key, names.length > 0 ? names.join(", ") : "default", ambient || typeOnlyDeclaration(declaration));
        for (const entry of declarationExports(declaration, isDefault, line)) {
          exports.push({ ...entry, unit });
        }
        if (!ambient && !declarationRunsNothing(declaration)) {
          declaredSince = new Map();
        }
        for (const name of names) {
          declaredSince.set(name, unit);
        }
        previousUnit = unit;
        continue;
      }

      // `export default <expression>`, `export = <expression>`.
      const unit = addUnit(statement, "declaration", [], "default", "default", false);
      exports.push({ name: "default", kind: "value", typeOnly: false, signature: null, line, unit });
      const value = statement.namedChildren.filter((child) => child !== null && child.type !== "comment").at(-1) ?? null;
      if (!valueRunsNothing(value)) {
        declaredSince = new Map();
      }
      continue;
    }

    if (statement.type === "expression_statement") {
      // `PhoneScreen.displayName = "PhoneScreen";` after PhoneScreen's
      // declaration, with nothing between that runs (comments, functions,
      // types, plain values): part of PhoneScreen, not code of its own.
      // Anything between that runs, an assignment to another declaration
      // too, and it stays a statement.
      const assignment = statement.namedChildren[0];
      const target = assignment?.type === "assignment_expression" ? assignment.childForFieldName("left") : null;
      const object = target?.type === "member_expression" ? target.childForFieldName("object") : null;
      const ownerIndex = object?.type === "identifier" ? declaredSince.get(object.text) : undefined;
      const owner: TopLevelUnit | undefined = ownerIndex === undefined ? undefined : units[ownerIndex];
      if (ownerIndex !== undefined && owner !== undefined && !owner.typeOnly) {
        const uses = usesIn(statement, false);
        owner.uses.push(...uses);
        owner.references.push(...uses.map((use) => use.name));
        owner.runtimeReferences.push(...uses.filter((use) => !use.inType).map((use) => use.name));
        owner.fingerprint = `${owner.fingerprint} ${fingerprintOf(statement, true)}`;
        owner.runtimeFingerprint = `${owner.runtimeFingerprint} ${fingerprintOf(statement, false)}`;
        const attached = commentsFrom !== null && commentsTo >= line - 1;
        owner.comments = [owner.comments, ...(attached ? commentsAbove : []).map(collapse), ...commentsIn(statement).map(collapse)]
          .filter((text) => text !== "")
          .join("\n");
        const endLine = statement.endPosition.row + 1;
        const lastPart = owner.parts.at(-1);
        if (previous === ownerIndex) {
          // Right below the owner's code: that code goes on.
          if (lastPart === undefined) {
            owner.endLine = endLine;
          } else {
            lastPart.endLine = endLine;
          }
        } else {
          owner.parts.push({ startLine: attached && commentsFrom !== null ? commentsFrom : line, endLine });
        }
        // It runs: only more of the owner's own can join it from here.
        declaredSince = new Map(owner.names.map((name) => [name, ownerIndex]));
        previousUnit = ownerIndex;
        continue;
      }

      const unit = addUnit(statement, "statement", [], `statement:${fingerprintOf(statement, true)}`, `line ${line}`, false);
      const commonjs = commonjsExport(statement);
      if (commonjs !== null) {
        exports.push({ ...commonjs, unit });
      }
      declaredSince = new Map();
      previousUnit = unit;
      continue;
    }

    const names = declaredNames(statement);
    const typeOnly = statement.type === "ambient_declaration" || typeOnlyDeclaration(statement);
    if (names !== null && names.length > 0) {
      const unit = addUnit(statement, "declaration", names, `name:${names.join(",")}`, names.join(", "), typeOnly);
      if (!declarationRunsNothing(statement)) {
        declaredSince = new Map();
      }
      for (const name of names) {
        declaredSince.set(name, unit);
      }
      previousUnit = unit;
    } else {
      const unit = addUnit(statement, "statement", [], `statement:${fingerprintOf(statement, true)}`, `line ${line}`, typeOnly);
      if (!typeOnly) {
        declaredSince = new Map();
      }
      previousUnit = unit;
    }
  }

  // Overloads and repeated statements share a key: number the repeats.
  const seenKeys = new Map<string, number>();
  for (const unit of units) {
    const count = seenKeys.get(unit.key) ?? 0;
    seenKeys.set(unit.key, count + 1);
    if (count > 0) unit.key = `${unit.key}#${count}`;
  }

  // Keep only references to names this file declares at the top level.
  const declared = new Set(units.flatMap((unit) => unit.names));
  for (const unit of units) {
    unit.references = [...new Set(unit.references)].filter((name) => declared.has(name) && !unit.names.includes(name));
    unit.uses = unit.uses.filter((use) => declared.has(use.name) && !unit.names.includes(use.name));
  }

  for (const { exportIndex, local } of localExports) {
    const unit = units.findIndex((candidate) => candidate.names.includes(local));
    const entry = exports[exportIndex];
    if (entry !== undefined && unit !== -1) {
      entry.unit = unit;
      entry.signature = signatureOfUnit(root, units[unit]);
    }
  }

  return { units, exports };
}

/** The names a declaration statement introduces at the top level; null when it isn't one. */
function declaredNames(node: Node): Array<string> | null {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "function_signature":
    case "class_declaration":
    case "abstract_class_declaration":
    case "interface_declaration":
    case "type_alias_declaration":
    case "enum_declaration": {
      const name = node.childForFieldName("name")?.text;
      return name === undefined ? [] : [name];
    }
    case "internal_module":
    case "module": {
      // `namespace A.B {}` declares A.
      const name = node.childForFieldName("name")?.text.split(".")[0]?.replace(/^["']|["']$/g, "");
      return name === undefined ? [] : [name];
    }
    case "lexical_declaration":
    case "variable_declaration":
      return node.namedChildren.flatMap((declarator) => (declarator?.type === "variable_declarator" ? boundNames(declarator.childForFieldName("name")) : []));
    case "ambient_declaration": {
      const inner = node.namedChildren.find((child) => child !== null && child.type !== "comment");
      return inner === undefined || inner === null ? [] : (declaredNames(inner) ?? []);
    }
    default:
      return null;
  }
}

/** What `export <declaration>` makes available, with each export's signature. */
function declarationExports(declaration: Node, isDefault: boolean, line: number): Array<Omit<Export, "unit">> {
  const name = (fallback: string) => (isDefault ? "default" : (declaration.childForFieldName("name")?.text ?? fallback));

  switch (declaration.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "function_signature":
    case "function_expression":
      return [{ name: name("default"), kind: "function", typeOnly: false, signature: functionSignature(declaration), line }];
    case "class_declaration":
    case "abstract_class_declaration":
    case "class":
      return [{ name: name("default"), kind: "class", typeOnly: false, signature: classSignature(declaration), line }];
    case "interface_declaration":
      return [{ name: name(""), kind: "interface", typeOnly: true, signature: collapse(declaration.text), line }];
    case "type_alias_declaration":
      return [{ name: name(""), kind: "type", typeOnly: true, signature: collapse(declaration.text), line }];
    case "enum_declaration":
      return [{ name: name(""), kind: "enum", typeOnly: false, signature: collapse(declaration.text), line }];
    case "internal_module":
    case "module":
      return [{ name: name(""), kind: "namespace", typeOnly: false, signature: null, line }];
    case "lexical_declaration":
    case "variable_declaration": {
      const exports: Array<Omit<Export, "unit">> = [];
      for (const declarator of declaration.namedChildren) {
        if (declarator?.type !== "variable_declarator") continue;
        const signature = variableSignature(declarator);
        for (const bound of boundNames(declarator.childForFieldName("name"))) {
          exports.push({ name: bound, kind: "variable", typeOnly: false, signature, line });
        }
      }
      return exports;
    }
    default:
      return [{ name: isDefault ? "default" : declaration.type, kind: "value", typeOnly: false, signature: null, line }];
  }
}

function functionSignature(node: Node): string {
  const parts = [node.childForFieldName("type_parameters")?.text, node.childForFieldName("parameters")?.text, node.childForFieldName("return_type")?.text];
  return collapse(parts.filter((part) => part !== undefined).join(""));
}

function classSignature(node: Node): string | null {
  const heritage = node.namedChildren.find((child) => child?.type === "class_heritage")?.text ?? "";
  const signature = collapse(`${node.childForFieldName("type_parameters")?.text ?? ""} ${heritage}`);
  return signature === "" ? null : signature;
}

/** A variable's type annotation; for a function value, the function's signature. */
function variableSignature(declarator: Node): string | null {
  const type = declarator.childForFieldName("type")?.text;
  if (type !== undefined) return collapse(type);
  const value = declarator.childForFieldName("value");
  if (value?.type === "arrow_function" || value?.type === "function_expression" || value?.type === "function") {
    return functionSignature(value);
  }
  return null;
}

/** The signature of what `export { a }` points at. */
function signatureOfUnit(root: Node, unit: TopLevelUnit | undefined): string | null {
  if (unit === undefined) return null;
  const statement = root.namedChildren.find((child) => child !== null && child.startPosition.row + 1 === unit.line);
  if (statement === undefined || statement === null) return null;
  const declaration = statement.type === "export_statement" ? statement.childForFieldName("declaration") : statement;
  if (declaration === null) return null;
  const local = unit.names[0];
  const exports = declarationExports(declaration, false, unit.line);
  return exports.find((entry) => entry.name === local)?.signature ?? null;
}

/** The names a binding introduces: `a`, or every name in `{ a, b: [c] }`. */
function boundNames(pattern: Node | null): Array<string> {
  if (pattern === null) return [];
  if (pattern.type === "identifier") return [pattern.text];
  const names: Array<string> = [];
  const visit = (node: Node) => {
    if (node.type === "shorthand_property_identifier_pattern" || node.type === "identifier") {
      names.push(node.text);
      return;
    }
    if (node.type === "pair_pattern") {
      // `{ key: value }`: only the value side is a name here.
      const value = node.childForFieldName("value");
      if (value !== null) visit(value);
      return;
    }
    // `{ a = 1 }`: the default value isn't a name.
    if (node.type === "object_assignment_pattern" || node.type === "assignment_pattern") {
      const left = node.childForFieldName("left");
      if (left !== null) visit(left);
      return;
    }
    for (const child of node.namedChildren) {
      if (child !== null) visit(child);
    }
  };
  visit(pattern);
  return names;
}

/** `module.exports = ...`, `module.exports.name = ...`, `exports.name = ...`. */
function commonjsExport(statement: Node): Omit<Export, "unit"> | null {
  const assignment = statement.namedChildren[0];
  if (assignment?.type !== "assignment_expression") return null;
  const target = collapse(assignment.childForFieldName("left")?.text ?? "");
  const line = statement.startPosition.row + 1;

  if (target === "module.exports") {
    return { name: "default", kind: "commonjs", typeOnly: false, signature: null, line };
  }
  const named = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(target);
  if (named !== null) {
    return { name: named[1] ?? "", kind: "commonjs", typeOnly: false, signature: null, line };
  }
  return null;
}

/**
 * A declaration that runs nothing when the file loads besides defining its
 * names: code after it can't tell it's there. Functions, types, classes
 * without `extends`, decorators or static code, variables set to plain
 * values (see valueRunsNothing). Unsure: it runs something.
 */
function declarationRunsNothing(node: Node): boolean {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "function_signature":
    case "interface_declaration":
    case "type_alias_declaration":
    case "ambient_declaration":
      return true;
    case "lexical_declaration":
    case "variable_declaration":
      // A destructuring pattern runs getters or an iterator: not plain.
      return node.namedChildren.every(
        (declarator) =>
          declarator === null ||
          declarator.type !== "variable_declarator" ||
          (declarator.childForFieldName("name")?.type === "identifier" && valueRunsNothing(declarator.childForFieldName("value"))),
      );
    case "enum_declaration":
      return (node.childForFieldName("body")?.namedChildren ?? []).every(
        (member) => member === null || member.type !== "enum_assignment" || valueRunsNothing(member.childForFieldName("value")),
      );
    case "class_declaration":
    case "abstract_class_declaration": {
      if (node.namedChildren.some((child) => child?.type === "class_heritage" || child?.type === "decorator")) return false;
      return (node.childForFieldName("body")?.namedChildren ?? []).every((member) => {
        if (member === null || member.type === "comment") return true;
        if (member.childForFieldName("name")?.type === "computed_property_name") return false;
        if (member.namedChildren.some((child) => child?.type === "decorator")) return false;
        // An instance field runs when an instance is made, a static one now.
        if (member.type === "public_field_definition") {
          return !member.children.some((child) => child?.type === "static") || valueRunsNothing(member.childForFieldName("value"));
        }
        return (
          member.type === "method_definition" ||
          member.type === "method_signature" ||
          member.type === "abstract_method_signature" ||
          member.type === "index_signature"
        );
      });
    }
    default:
      return false;
  }
}

/**
 * A value that runs nothing to make: a function, a literal, a name, or an
 * array or object of those. No value at all counts too. A call, `new`, a
 * spread or a computed key runs something.
 */
function valueRunsNothing(node: Node | null): boolean {
  if (node === null) return true;
  switch (node.type) {
    case "arrow_function":
    case "function_expression":
    case "function":
    case "generator_function":
    case "string":
    case "number":
    case "true":
    case "false":
    case "null":
    case "undefined":
    case "regex":
    case "identifier":
      return true;
    case "template_string":
      return !node.namedChildren.some((child) => child?.type === "template_substitution");
    case "unary_expression":
      // `-1`; on anything else it could call valueOf.
      return node.childForFieldName("argument")?.type === "number";
    case "parenthesized_expression":
    case "as_expression":
    case "satisfies_expression":
    case "non_null_expression":
      return valueRunsNothing(node.namedChildren.find((child) => child !== null && child.type !== "comment") ?? null);
    case "array":
      return node.namedChildren.every((child) => child === null || child.type === "comment" || valueRunsNothing(child));
    case "object":
      return node.namedChildren.every((member) => {
        if (member === null || member.type === "comment" || member.type === "shorthand_property_identifier") return true;
        if (member.type === "method_definition") return member.childForFieldName("name")?.type !== "computed_property_name";
        if (member.type === "pair") return member.childForFieldName("key")?.type !== "computed_property_name" && valueRunsNothing(member.childForFieldName("value"));
        return false;
      });
    default:
      return false;
  }
}

/** A declaration that only exists for the type checker. */
function typeOnlyDeclaration(node: Node): boolean {
  return node.type === "interface_declaration" || node.type === "type_alias_declaration" || node.type === "function_signature";
}

/**
 * Syntax that's only types: gone after compiling, so it changes nothing
 * that runs. (Inside a class too: overload and index signatures.)
 */
const typeNodes = new Set([
  "type_annotation",
  "type_arguments",
  "type_parameters",
  "implements_clause",
  "interface_declaration",
  "type_alias_declaration",
  "ambient_declaration",
  "function_signature",
  "method_signature",
  "abstract_method_signature",
  "index_signature",
  "type_predicate_annotation",
  "asserts_annotation",
  "opting_type_annotation",
  "omitting_type_annotation",
  "adding_type_annotation",
]);

/**
 * The part of an expression that runs, when the rest is only a type:
 * `x as T`, `x satisfies T` and `x!` are `x`; `<T>x` is `x`. Null: not such an expression.
 */
function runtimePartOf(node: Node): Node | null {
  if (node.type === "as_expression" || node.type === "satisfies_expression" || node.type === "non_null_expression") return node.namedChildren[0] ?? null;
  if (node.type === "type_assertion") return node.namedChildren.at(-1) ?? null;
  return null;
}

/** Every name the code mentions that could be a top-level binding, as its node, and whether it's in a type. */
function referencesIn(node: Node): Array<{ node: Node; inType: boolean }> {
  const names: Array<{ node: Node; inType: boolean }> = [];
  const visit = (current: Node, inType: boolean) => {
    if (current.type === "identifier" || current.type === "type_identifier" || current.type === "shorthand_property_identifier") {
      names.push({ node: current, inType: inType || current.type === "type_identifier" });
      return;
    }
    const nested = inType || typeNodes.has(current.type);
    // In `x as T`, only `x` runs.
    const runs = runtimePartOf(current);
    for (const child of current.namedChildren) {
      if (child !== null) visit(child, nested || (runs !== null && child.id !== runs.id));
    }
  };
  visit(node, false);
  return names;
}

/**
 * The code's tokens, so formatting doesn't count as a change: no comments
 * or whitespace, no semicolons (optional in JS), no trailing commas, and
 * JSX text with its whitespace collapsed. Without `types`, the types are
 * left out too (see `typeNodes`, `runtimePartOf`): what's left is what runs.
 */
function fingerprintOf(node: Node, types: boolean): string {
  const tokens: Array<string> = [];
  const visit = (current: Node) => {
    if (current.type === "comment") return;
    if (!types) {
      if (typeNodes.has(current.type)) return;
      const runs = runtimePartOf(current);
      if (runs !== null) {
        visit(runs);
        return;
      }
    }
    if (current.childCount === 0 || current.type === "string" || current.type === "template_string" || current.type === "regex") {
      if (current.type === "jsx_text") {
        const text = collapse(current.text);
        if (text !== "") tokens.push(text);
      } else if (current.text !== ";" && current.text !== "") {
        tokens.push(current.text);
      }
      return;
    }
    for (const child of current.children) {
      if (child !== null) visit(child);
    }
  };
  visit(node);
  return tokens.filter((token, index) => !(token === "," && [")", "]", "}", ">"].includes(tokens[index + 1] ?? ""))).join(" ");
}

/** The text of every comment in the code, in order. */
function commentsIn(node: Node): Array<string> {
  if (node.type === "comment") return [node.text];
  return node.children.flatMap((child) => (child === null ? [] : commentsIn(child)));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
