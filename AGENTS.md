# Working on Behind the Room

What the project is, and how to run it: [README.md](README.md). This file is
what an agent needs on top of that to change it.

## Commands

```sh
pnpm install
pnpm typecheck        # every package
pnpm test             # every package (node:test)
pnpm dev              # the app with every repository, http://localhost:4700
room <repo...>        # apps/web/bin/room.ts: builds when the source changed, serves on 4800
```

Node 26 (pnpm downloads it), TypeScript run directly: no build step for the
packages. Before calling work done: `pnpm typecheck` and `pnpm test` pass, and
the change is seen working in a browser (the graphs especially: a screenshot
of the page, or of the SVG on its own, says more than the tests).

A running `room` doesn't pick up changes: stop it and start it again.

## Git

Commit on `main`. Use a branch only for work in parallel, or to try an
alternative beside main.

## Code conventions

- Imports: `#/…` for the package's own source (`"#/paths.ts"`), with the
  `.ts`/`.tsx` extension written out. No `@/` aliases.
- A page is `apps/web/app/routes/<route>/route.tsx` (loader, action, every
  decision) and `components.tsx` beside it (markup, styling, JavaScript
  niceties).
- Strings inline, even when repeated; repeated guards and control flow stay
  written out rather than hidden in helpers.
- Comments say why, in plain words about what the user sees.
- Tests: `node:test`, `<name>.test.ts` beside the code. Many are TOML tables
  of cases (`<name>.toml` + `<name>.toml.test.ts`, with `@dral/toml-tests`):
  add a case there before adding a test file.

## How a page of changes works

A commit, a comparison or the work tree's current changes all render
`apps/web/app/components/changes-page.tsx`. Its tabs are `?view=`:
`reach` (default), `declarations`, `lines`, `module`, `combined` (shown as
"Ripple") and `flat` ("Ripple, no file boxes").

1. The route's loader diffs and analyzes the changed files
   (`changes.server.ts` → `analyze-diff.server.ts`, using `@room/syntax`).
   Each file is split into top-level declarations, with a status: changed,
   added, removed, affected (same code, uses something that changed), or
   only types/comments/formatting (`nothingRuns` in `graphs.ts`). Views about
   what runs leave the last kind out.
2. Two things are slow, so the page fetches them in its own requests:
   - Reach: `routes/$owner.$repo.reach` → `changesReach` in `reach.server.ts`.
     It scans every source file of the commit and its parent (cached per commit
     in `scanRepository`), then `computeReach` in `reach.ts` follows imports
     name by name to what each file can reach.
   - The declaration graph: `routes/$owner.$repo.graph` → `changesGraph` in
     `graph.server.ts`. It builds `declarationGraph` (declaration-graph.ts)
     from the same scan. The ripple is everything that uses a changed
     declaration, through the whole repository (nearest 150 shown). It also
     returns the links a change added or removed, and which points each
     declaration reaches.
3. Ripple is drawn by `components/graphs.tsx`:
   - `graphs.ts` turns the data into nodes, edges and boxes
     (`appBoxesGraph`, `rippleWithoutFileBoxes`). A box per file, in a box
     per app or package (the nearest package.json's folder).
   - It's laid out with ELK (`graph-layout-elk.ts`) or dagre (`layoutGraph`,
     to compare). dagre can't lay out some graphs in boxes, so it draws
     those without boxes.
   - It's drawn as SVG on a pan/zoom canvas (`packages/canvas`), stuck to
     the top of the code column.
4. The graph and the page talk through window events:
   - `room:reading`: the declaration scrolled to, which the graph marks.
   - `room:focus`: the files on a clicked declaration's paths. The others
     are hidden below the graph and dimmed in the tree.
   - `room:focus-clear`: sent when a file is picked in the tree.
   The code column's scrolling and jumping (`#file-3`, `#file-3--name` for a
   declaration) is in `ChangesView` in `components/changes.tsx`.

## A repository's `.room.toml`

Read from the repository's work tree as it is now (a GitHub repository: its
default branch), not from the commit shown. So it applies to every commit and
branch, and an edit shows on the next page load.

```toml
[[points]]                 # what matters: shown first in Reach and the graphs
name = "Medplum"
about = "The patient record"
packages = ["@medplum/*"]  # importing these reaches it
files = ["src/medplum/**"] # this code is it
declarations = ["src/db.ts#db"]

[[ignore]]                 # set aside, like tests and stories
name = "generated"
files = ["**/generated/**"]
```

A point takes over: code inside it, and a package it names, count as that
point, not as the capabilities they would give (network, database, ...).
Parsing is in `points.ts` and `rules.server.ts`, and the reading in
`room-toml.server.ts`. Built-in set-aside rules (tests, stories) are in
`rules.server.ts`.

## Packages

| Path | What it is |
|---|---|
| `packages/diff` | Parses git's unified diff. |
| `packages/git` | Talks to `git`: local repositories in place, GitHub ones cloned bare into `~/.cache/behind-the-room/repos`. Branches (local, then origin's), commits, comparisons, fetch. |
| `packages/syntax` | tree-sitter for TS/TSX/JS: highlighting, imports and exports, the module graph, and comparing two versions declaration by declaration (`compare-declarations.ts`). |
| `packages/canvas` | A framework-free pan/zoom canvas: drag, wheel, pinch, fit, show a rect. View math in `view.ts`, tested. |
| `apps/web` | The React Router 8 app, and the `room` command (`bin/room.ts`). |
