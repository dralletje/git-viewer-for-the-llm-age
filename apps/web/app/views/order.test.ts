import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphDeclaration } from "#/graph.server.ts";
import { readingOrder } from "#/views/order.ts";

/** A declaration "path#label" at a line, with a status. */
function declaration(id: string, line: number, status: GraphDeclaration["status"] = "affected"): GraphDeclaration {
  const [path = "", label = ""] = id.split("#");
  return { id, path: status === "outside" ? "" : path, label, line, endLine: line + 3, parts: [], status, tag: null, exported: true };
}

function graph(
  declarations: Array<GraphDeclaration>,
  seeds: Array<string>,
  edges: Array<[used: string, user: string]>,
  links: Array<{ from: string; to: string; status: "added" | "removed" | "kept" }> = [],
) {
  return {
    declarations: Object.fromEntries(declarations.map((entry) => [entry.id, entry])),
    seeds,
    ripple: { edges: edges.map(([from, to]) => ({ from, to })), affected: 0, shown: 0 },
    links,
  };
}

const ids = (rows: ReturnType<typeof readingOrder>) => rows.map((row) => row.declaration.id);

test("what's used comes before what uses it, whatever the paths say", () => {
  const rows = readingOrder(
    graph([declaration("z.ts#base", 1, "changed"), declaration("a.ts#middle", 1), declaration("a.ts#top", 9)], ["z.ts#base"], [
      ["z.ts#base", "a.ts#middle"],
      ["a.ts#middle", "a.ts#top"],
    ]),
  );
  assert.deepEqual(ids(rows), ["z.ts#base", "a.ts#middle", "a.ts#top"]);
  assert.deepEqual(
    rows.map((row) => row.depth),
    [0, 1, 2],
  );
  assert.deepEqual(
    rows.map((row) => row.usesLater),
    [false, false, false],
  );
});

test("changed declarations first among the ones that could come next", () => {
  const rows = readingOrder(
    graph([declaration("a.ts#plain", 1, "unchanged"), declaration("b.ts#changed", 1, "changed"), declaration("c.ts#user", 1)], ["b.ts#changed"], [
      ["b.ts#changed", "c.ts#user"],
    ], [{ from: "c.ts#user", to: "a.ts#plain", status: "added" }]),
  );
  // c.ts#user waits for both; the change goes before the plain one it newly uses.
  assert.deepEqual(ids(rows), ["b.ts#changed", "a.ts#plain", "c.ts#user"]);
  assert.equal(rows[1]?.depth, 2);
});

test("a link's from is the one that uses: what it newly uses comes first", () => {
  const rows = readingOrder(
    graph([declaration("a.ts#user", 1, "changed"), declaration("b.ts#helper", 1, "unchanged")], ["a.ts#user"], [], [
      { from: "a.ts#user", to: "b.ts#helper", status: "added" },
    ]),
  );
  assert.deepEqual(ids(rows), ["b.ts#helper", "a.ts#user"]);
  assert.equal(rows[0]?.depth, 1);
});

test("a use that went away doesn't order anything, and packages and removed declarations aren't listed", () => {
  const rows = readingOrder(
    graph(
      [declaration("a.ts#user", 5, "changed"), declaration("a.ts#first", 1, "changed"), declaration("old.ts#gone", 1, "removed"), declaration("outside\0react", 0, "outside")],
      ["a.ts#user", "a.ts#first"],
      [],
      [
        { from: "a.ts#first", to: "a.ts#user", status: "removed" },
        { from: "a.ts#user", to: "old.ts#gone", status: "removed" },
        { from: "a.ts#user", to: "outside\0react", status: "added" },
      ],
    ),
  );
  assert.deepEqual(ids(rows), ["a.ts#first", "a.ts#user"]);
});

test("a file's declarations stay together when the uses allow it", () => {
  const rows = readingOrder(
    graph(
      [declaration("a.ts#one", 1, "changed"), declaration("b.ts#other", 1, "changed"), declaration("a.ts#two", 5), declaration("b.ts#user", 9)],
      ["a.ts#one", "b.ts#other"],
      [
        ["a.ts#one", "a.ts#two"],
        ["b.ts#other", "b.ts#user"],
      ],
    ),
  );
  // By depth alone b.ts#other (a change) would come before a.ts#two.
  assert.deepEqual(ids(rows), ["a.ts#one", "a.ts#two", "b.ts#other", "b.ts#user"]);
});

test("a cycle is broken by distance from a change, then path and line, and says so", () => {
  const cycle = () =>
    graph(
      [declaration("s.ts#seed", 1, "changed"), declaration("b.ts#ping", 1), declaration("a.ts#pong", 1), declaration("c.ts#after", 1)],
      ["s.ts#seed"],
      [
        ["s.ts#seed", "b.ts#ping"],
        ["b.ts#ping", "a.ts#pong"],
        ["a.ts#pong", "b.ts#ping"],
        ["a.ts#pong", "c.ts#after"],
      ],
    );
  const rows = readingOrder(cycle());
  // ping is one use from the change, pong two: ping first, though it uses pong.
  assert.deepEqual(ids(rows), ["s.ts#seed", "b.ts#ping", "a.ts#pong", "c.ts#after"]);
  assert.deepEqual(
    rows.map((row) => row.usesLater),
    [false, true, false, false],
  );
  // The same every time.
  assert.deepEqual(ids(readingOrder(cycle())), ids(rows));
});

test("a cycle among changes alone: by path, then line", () => {
  const rows = readingOrder(
    graph([declaration("b.ts#x", 1, "changed"), declaration("a.ts#y", 3, "changed"), declaration("a.ts#w", 1, "changed")], ["b.ts#x", "a.ts#y", "a.ts#w"], [
      ["b.ts#x", "a.ts#y"],
      ["a.ts#y", "a.ts#w"],
      ["a.ts#w", "b.ts#x"],
    ]),
  );
  assert.deepEqual(ids(rows), ["a.ts#w", "b.ts#x", "a.ts#y"]);
  assert.deepEqual(
    rows.map((row) => row.seed),
    [true, true, true],
  );
});
