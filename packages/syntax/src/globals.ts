import type { Node } from "web-tree-sitter";
import { declaredNames, isScope } from "#/scope.ts";

/**
 * One place code uses a global: a name no enclosing scope declares.
 * - call: `fetch(url)`, also `globalThis.fetch(url)` (or `window.`, `self.`): `name` is "fetch".
 * - new: `new WebSocket(url)`: `name` is "WebSocket".
 * - member: `process.env`, `Bun.spawn`, `import.meta.env`: `name` is the
 *   object ("process", "import.meta"), `property` what's read on it.
 */
export type GlobalUse = { kind: "call" | "new" | "member"; name: string; property: string | null; line: number };

/** Objects that hold the globals: `globalThis.fetch` is `fetch`. */
const globalObjects = new Set(["globalThis", "window", "self"]);

/**
 * Every call, construction and member read on a global, in the order of the
 * code. A name counts as global only where no enclosing scope declares it:
 * a parameter, variable, function or import named `fetch` isn't the global
 * (see scope.ts). `import.meta` is syntax, so it's always the real one.
 */
export function findGlobalUses(root: Node): Array<GlobalUse> {
  const uses: Array<GlobalUse> = [];
  /** The names declared in each scope around the node being visited, innermost last. */
  const scopes: Array<Set<string>> = [];
  const declared = (name: string) => scopes.some((names) => names.has(name));

  /** `fetch` for `fetch` and for `globalThis.fetch`, when that is the global; null for anything else. */
  const globalName = (node: Node | null): string | null => {
    if (node === null) return null;
    if (node.type === "identifier") return declared(node.text) ? null : node.text;
    if (node.type === "member_expression") {
      const object = node.childForFieldName("object");
      if (object !== null && object.type === "identifier" && globalObjects.has(object.text) && !declared(object.text)) {
        return node.childForFieldName("property")?.text ?? null;
      }
    }
    return null;
  };

  const visit = (node: Node) => {
    const line = node.startPosition.row + 1;
    if (node.type === "call_expression") {
      const name = globalName(node.childForFieldName("function"));
      if (name !== null) uses.push({ kind: "call", name, property: null, line });
    } else if (node.type === "new_expression") {
      const name = globalName(node.childForFieldName("constructor"));
      if (name !== null) uses.push({ kind: "new", name, property: null, line });
    } else if (node.type === "member_expression") {
      const object = node.childForFieldName("object");
      const property = node.childForFieldName("property")?.text ?? null;
      const isGlobal = object !== null && (object.type === "identifier" ? !declared(object.text) : object.text === "import.meta");
      if (object !== null && isGlobal) uses.push({ kind: "member", name: object.text, property, line });
    }
    const scope = isScope(node);
    if (scope) scopes.push(declaredNames(node));
    for (const child of node.namedChildren) {
      if (child !== null) visit(child);
    }
    if (scope) scopes.pop();
  };
  visit(root);
  return uses;
}
