import type { Node } from "web-tree-sitter";
import type { LineRange } from "#/compare-declarations.ts";

/**
 * A file's syntax tree, as much of it as comparing two versions needs: a
 * node that spans several lines keeps its parts (its named children, no
 * comments); a node on one line is where it stops, since its line is shown
 * whole anyway (with its changed words marked).
 */
export type OutlineNode = {
  type: string;
  /** What finds the same part in the other version: a method's, property's, variable's name, a JSX tag, a call's callee. */
  name: string | null;
  /** How a path through the tree shows it: "save()", "<Button>", "if (ready)". Null: a part not worth naming (a block, an argument list). */
  label: string | null;
  /** Its tokens, hashed: equal when only formatting or comments changed. */
  hash: string;
  /** Its own tokens (keywords, operators), its parts aside, hashed. */
  own: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Empty for a node on one line. */
  children: Array<OutlineNode>;
};

export function extractOutline(root: Node): OutlineNode {
  return outlineOf(root).node;
}

function outlineOf(node: Node): { node: OutlineNode; hash: string } {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  // A token: hashed by its text (JSX text with its whitespace collapsed).
  if (node.childCount === 0 || node.type === "string" || node.type === "template_string" || node.type === "regex") {
    const text = node.type === "jsx_text" ? collapse(node.text) : node.text;
    const hash = hashOf(text);
    return { node: { type: node.type, name: null, label: null, hash, own: hash, startLine, endLine, children: [] }, hash };
  }

  const parts: Array<string> = [node.type];
  const ownParts: Array<string> = [node.type];
  const children: Array<OutlineNode> = [];
  for (const child of node.children) {
    if (child === null || child.type === "comment") continue;
    // Semicolons are optional, commas separate (a trailing one is formatting).
    if (!child.isNamed && (child.text === ";" || child.text === ",")) continue;
    if (!child.isNamed) {
      parts.push(child.text);
      ownParts.push(child.text);
      continue;
    }
    // jsx_text that is only whitespace: formatting.
    if (child.type === "jsx_text" && collapse(child.text) === "") continue;
    const inner = outlineOf(child);
    parts.push(inner.hash);
    children.push(inner.node);
  }
  const hash = hashOf(parts.join(" "));
  return {
    node: {
      type: node.type,
      name: nameOf(node),
      label: labelOf(node),
      hash,
      own: hashOf(ownParts.join(" ")),
      startLine,
      endLine,
      children: startLine === endLine ? [] : children,
    },
    hash,
  };
}

function nameOf(node: Node): string | null {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "function_signature":
    case "class_declaration":
    case "abstract_class_declaration":
    case "interface_declaration":
    case "type_alias_declaration":
    case "enum_declaration":
    case "method_definition":
    case "method_signature":
    case "abstract_method_signature":
    case "public_field_definition":
    case "property_signature":
    case "variable_declarator":
      return node.childForFieldName("name")?.text ?? null;
    case "lexical_declaration":
    case "variable_declaration": {
      const names = node.namedChildren.flatMap((child) => (child?.type === "variable_declarator" ? [child.childForFieldName("name")?.text ?? ""] : []));
      return names.length === 0 ? null : names.join(",");
    }
    case "pair":
      return node.childForFieldName("key")?.text ?? null;
    case "jsx_element":
      return node.childForFieldName("open_tag")?.childForFieldName("name")?.text ?? null;
    case "jsx_self_closing_element":
    case "jsx_opening_element":
      return node.childForFieldName("name")?.text ?? null;
    case "jsx_attribute":
      return node.namedChildren[0]?.text ?? null;
    case "call_expression":
      return calleeOf(node);
    case "switch_case":
      return collapse(node.childForFieldName("value")?.text ?? "default");
    case "if_statement":
    case "while_statement":
      return collapse(node.childForFieldName("condition")?.text ?? "");
    case "expression_statement":
    case "export_statement":
    case "return_statement":
    case "await_expression": {
      const inner = node.namedChildren.find((child) => child !== null && child.type !== "comment") ?? null;
      if (inner === null) return null;
      if (inner.type === "assignment_expression") return collapse(inner.childForFieldName("left")?.text ?? "");
      const name = nameOf(inner);
      return name === null ? null : `${inner.type} ${name}`;
    }
    default:
      return null;
  }
}

function labelOf(node: Node): string | null {
  const name = node.childForFieldName("name")?.text;
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
      return `function ${name ?? ""}`;
    case "class_declaration":
    case "abstract_class_declaration":
      return `class ${name ?? ""}`;
    case "method_definition":
    case "method_signature":
    case "abstract_method_signature":
      return `${name ?? ""}()`;
    case "public_field_definition":
    case "property_signature":
    case "variable_declarator":
      return name ?? null;
    case "pair":
      return `${short(node.childForFieldName("key")?.text ?? "")}:`;
    case "jsx_element":
    case "jsx_self_closing_element":
      return `<${nameOf(node) ?? ""}>`;
    case "jsx_attribute":
      return `${nameOf(node) ?? ""}=`;
    case "call_expression": {
      const callee = calleeOf(node);
      return callee === null ? "call" : callee.endsWith(")") ? callee : `${callee}(…)`;
    }
    case "if_statement":
      return `if (${short(collapse(node.childForFieldName("condition")?.text.replace(/^\(|\)$/g, "") ?? ""))})`;
    case "else_clause":
      return "else";
    case "switch_statement":
      return `switch (${short(collapse(node.childForFieldName("value")?.text.replace(/^\(|\)$/g, "") ?? ""))})`;
    case "switch_case":
      return `case ${short(nameOf(node) ?? "")}`;
    case "switch_default":
      return "default";
    case "return_statement":
      return "return";
    case "try_statement":
      return "try";
    case "catch_clause":
      return "catch";
    case "finally_clause":
      return "finally";
    case "for_statement":
    case "for_in_statement":
      return "for";
    case "while_statement":
      return "while";
    default:
      return null;
  }
}

/** `useEffect`, `router.get`, `it("does x")`: a long or computed callee has none. */
function calleeOf(node: Node): string | null {
  const callee = collapse(node.childForFieldName("function")?.text ?? "");
  if (callee === "" || callee.length > 40) return null;
  const first = node.childForFieldName("arguments")?.namedChildren[0];
  if (first?.type === "string") {
    const quote = first.text[0] ?? "'";
    const inner = first.text.slice(1, -1);
    return `${callee}(${quote}${inner.length > 30 ? `${inner.slice(0, 29)}…` : inner}${quote})`;
  }
  return callee;
}

/** One change found by `compareOutlines`: the smallest part of the code that changed, and where it is. */
export type PartChange = {
  /** The labels of the parts it's in, outermost first, its own last (if it has one). */
  path: Array<string>;
  /**
   * Where it is, as code: the first line of each part it's in (the
   * declaration's first, then inward), in both versions. Only lines above
   * the change; nested parts starting on the same line count once.
   */
  context: Array<{ before: number; after: number }>;
  before: LineRange | null;
  after: LineRange | null;
};

type Scope = Array<{ before: number; after: number }>;

/**
 * What changed between two versions of a part of the code, as deep in it as
 * can be told apart: the parts of both are matched (by name, else by
 * equal code), and a matched part that changed is looked into the same way.
 * Unmatched parts between two matched ones are paired when they line up
 * one to one with the same kind; otherwise they are one change together.
 *
 * Not an exact science: an unnamed part (a statement, an argument) that
 * changed is matched by where it is, which is a guess, and a part that
 * moved is a removal and an addition.
 */
export function compareOutlines(before: OutlineNode, after: OutlineNode): Array<PartChange> {
  const changes: Array<PartChange> = [];
  compareNodes(before, after, [], [], changes, true);
  return mergeOverlapping(changes);
}

function compareNodes(
  before: OutlineNode,
  after: OutlineNode,
  path: Array<string>,
  outer: Scope,
  changes: Array<PartChange>,
  top = false,
): void {
  if (before.hash === after.hash) return;
  // The declaration itself is named above its changes already.
  const here = after.label === null || top ? path : [...path, after.label];
  const last = outer.at(-1);
  // A body's first line ends what it belongs to (`}): Promise<X> {`): that one's own first line says it already.
  const body = after.type === "statement_block" || after.type === "class_body";
  const scope =
    body || (last !== undefined && last.before === before.startLine && last.after === after.startLine)
      ? outer
      : [...outer, { before: before.startLine, after: after.startLine }];
  // The scope lines above the change: in the new version, or the old one for a removal.
  const push = (change: Omit<PartChange, "context">) => {
    const context = scope.filter((entry) =>
      change.after !== null ? entry.after < change.after.startLine : change.before !== null && entry.before < change.before.startLine,
    );
    changes.push({ ...change, context });
  };

  if (before.children.length === 0 || after.children.length === 0 || before.type !== after.type) {
    push({ path: here, before: rangeOf(before), after: rangeOf(after) });
    return;
  }

  const keyOf = (node: OutlineNode) => (node.name === null ? `#${node.hash}` : `${node.type}\0${node.name}`);
  const steps = matchSequences(before.children.map(keyOf), after.children.map(keyOf));

  // Rewritten more than changed (no part the same, several parts): one change, not pieces of it.
  const anyUnchanged = steps.some((step) => step.kind === "same" && before.children[step.a]?.hash === after.children[step.b]?.hash);
  if (!anyUnchanged && before.children.length > 1 && after.children.length > 1) {
    push({ path: here, before: rangeOf(before), after: rangeOf(after) });
    return;
  }

  // Its own tokens changed (`let` to `const`, `async` added, an operator): its first line.
  if (before.own !== after.own) {
    push({ path: here, before: headOf(before), after: headOf(after) });
  }

  let index = 0;
  while (index < steps.length) {
    const step = steps[index];
    if (step?.kind === "same") {
      const old = before.children[step.a];
      const next = after.children[step.b];
      // Through `export`, `const`: still the declaration itself.
      const wrapper = top && ["export_statement", "lexical_declaration", "variable_declaration", "ambient_declaration"].includes(after.type);
      if (old !== undefined && next !== undefined) compareNodes(old, next, here, scope, changes, wrapper);
      index++;
      continue;
    }
    const removed: Array<OutlineNode> = [];
    const added: Array<OutlineNode> = [];
    while (index < steps.length && steps[index]?.kind !== "same") {
      const current = steps[index];
      if (current?.kind === "removed") removed.push(before.children[current.a] as OutlineNode);
      if (current?.kind === "added") added.push(after.children[current.b] as OutlineNode);
      index++;
    }
    // One to one, the same kinds: probably each changed in place (a guess).
    if (removed.length === added.length && removed.every((node, pair) => node.type === added[pair]?.type)) {
      removed.forEach((node, pair) => compareNodes(node, added[pair] as OutlineNode, here, scope, changes));
      continue;
    }
    push({
      path: added.length === 1 && removed.length === 0 && added[0]?.label != null ? [...here, added[0].label] : here,
      before: removed.length === 0 ? null : { startLine: removed[0]?.startLine ?? 0, endLine: removed.at(-1)?.endLine ?? 0 },
      after: added.length === 0 ? null : { startLine: added[0]?.startLine ?? 0, endLine: added.at(-1)?.endLine ?? 0 },
    });
  }
}

/** Changes that share lines (two parts on one line): one change, at the path and scope they share. */
function mergeOverlapping(changes: Array<PartChange>): Array<PartChange> {
  const overlaps = (a: LineRange | null, b: LineRange | null) => a !== null && b !== null && a.startLine <= b.endLine && b.startLine <= a.endLine;
  const union = (a: LineRange | null, b: LineRange | null): LineRange | null =>
    a === null ? b : b === null ? a : { startLine: Math.min(a.startLine, b.startLine), endLine: Math.max(a.endLine, b.endLine) };
  const position = (change: PartChange) => change.after?.startLine ?? change.before?.startLine ?? 0;

  const merged: Array<PartChange> = [];
  for (const change of [...changes].sort((a, b) => position(a) - position(b))) {
    const last = merged.at(-1);
    if (last !== undefined && (overlaps(last.before, change.before) || overlaps(last.after, change.after))) {
      const path: Array<string> = [];
      for (let depth = 0; depth < Math.min(last.path.length, change.path.length) && last.path[depth] === change.path[depth]; depth++) {
        path.push(last.path[depth] ?? "");
      }
      const context: Scope = [];
      for (
        let depth = 0;
        depth < Math.min(last.context.length, change.context.length) &&
        last.context[depth]?.before === change.context[depth]?.before &&
        last.context[depth]?.after === change.context[depth]?.after;
        depth++
      ) {
        context.push(last.context[depth] ?? { before: 0, after: 0 });
      }
      const before = union(last.before, change.before);
      const after = union(last.after, change.after);
      // Still only lines above the merged change.
      merged[merged.length - 1] = {
        path,
        context: context.filter((entry) => (after !== null ? entry.after < after.startLine : before !== null && entry.before < before.startLine)),
        before,
        after,
      };
      continue;
    }
    merged.push(change);
  }
  return merged;
}

function rangeOf(node: OutlineNode): LineRange {
  return { startLine: node.startLine, endLine: node.endLine };
}

/** Its first line: where its keywords are, mostly. */
function headOf(node: OutlineNode): LineRange {
  return { startLine: node.startLine, endLine: node.startLine };
}

type Step = { kind: "same"; a: number; b: number } | { kind: "removed"; a: number } | { kind: "added"; b: number };

/** The longest common subsequence of two short lists of keys, as steps. */
function matchSequences(a: Array<string>, b: Array<string>): Array<Step> {
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const steps: Array<Step> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      steps.push({ kind: "same", a: i++, b: j++ });
    } else if (j >= b.length || (i < a.length && lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) {
      steps.push({ kind: "removed", a: i++ });
    } else {
      steps.push({ kind: "added", b: j++ });
    }
  }
  return steps;
}

function short(text: string): string {
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** cyrb53: a fast 53-bit string hash, as base 36. */
function hashOf(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
