# Capabilities scan

## Why

The room is for reading code an LLM wrote. Most of a commit can't hurt
anything on its own; the parts that can are the ones that reach outside the
program: the file system, the network, child processes, env vars, a
database, `eval`. The scan says which files can reach those, so attention
goes to the files that can, and to commits that give a file a reach it
didn't have.

## Goals

- For every TS/JS file in the repository at a commit: what it can reach, and
  why, as a chain of imports ending at the import or global that gives it
  (`route.tsx → db.ts → pg`).
- On a commit's page: which files gain a reach in this commit, grouped by
  what causes it, including files the commit didn't touch (a change to
  `db.ts` gives every file that imports it database reach).
- Each changed file's header shows what it reaches; a file that reaches
  nothing says so, as the low-risk sign.

## Non-goals

- Looking inside `node_modules` or npm packages: a package counts by its
  name (`pg` is database, `axios` is network).
- Data flow: a file that imports `fs` reaches the file system, whether it
  calls it or not.
- Precision inside a top-level declaration: a function that reads files in
  one branch reaches the file system whichever branch runs.
- Types: tracked by `@room/syntax` (exported types, `import { type A }`),
  but they never carry reach, since they don't run.
- The current-changes and compare pages (commit page only, for now).

## Precision added after the first version

- **Names, through the code.** An imported name leads to the top-level
  code that defines it, and on through what that code uses: names in its
  own file, and imported names into other files. Importing `pure` from a
  file that also reads files reaches nothing. This goes past barrel files
  (`export { a } from`, `export *`, renames, `import { a }; export { a }`).
  `import * as x`, `require` and `import()` get the whole module; a file's
  own chips show everything its code can reach, re-exports included.
- **Loading.** Top-level statements run when a file is loaded, so importing
  any name from a file reaches what they do, and loading a file loads the
  files it imports. A declaration's initializer (`const pool = new Pool()`)
  counts as part of that declaration, reached when it's used.
- **CommonJS** files count as a whole: their exports aren't known from syntax.
- **Scopes.** A global counts only where no enclosing scope declares a name
  like it: a parameter, variable, function, class, import, catch error or
  loop variable named `fetch` isn't the global. A `var` belongs to its whole
  function (blocks and loops included); `let`, `const`, functions and classes
  to their block. `globalThis.fetch` is always the global, and `declare`
  describes the global rather than hiding it.
- **Where the rules live.** `@room/syntax` only reports what the code says:
  imports, every use of a global (`findGlobalUses`), exported names, and the
  module graph (`scanSource`). What counts as a capability is decided in the
  app (`apps/web/app/capabilities.ts`), so it can grow from other sources.

## Approaches

1. **Changed files only, direct imports.** Cheap, but misses reach that
   comes through another file, which is most of it in a real app.
2. **Whole repo at the commit and its parent (picked).** List every file
   with `git ls-tree`, parse each one's imports and globals (cached per
   blob, so the next commit re-parses only what changed), resolve imports
   to files, and follow them. A GitHub clone has no file contents yet: the
   missing blobs are fetched in one `git fetch`, once.
3. **A TypeScript program (tsc's resolver and checker).** Exact resolution
   and shadowing, but needs a work tree and `node_modules`, which a bare
   GitHub clone doesn't have, and is far slower.

## Design

- `@room/syntax`: `scanSource(language, source)` returns a file's imports,
  every use of a global, its exported names (values and types) and its
  module graph. No capabilities: it doesn't know what a module or global
  means.
- `apps/web/app/capabilities.ts`: the module and global tables (`fetch`,
  `process.env`, `eval`, `new Function`, `Bun.*`, `Deno.*`, `pg`,
  `node:fs`, ...) and what a use of each gives; tests in `capabilities.toml`.
- `@room/git`: `listFiles(repository, commit)` (path and blob per file) and
  `fetchMissingBlobs(repository, commit)` for partial clones.
- `apps/web/app/reach.server.ts`: resolves imports (relative paths with TS's
  extension rules, `index` files, package.json `imports` such as `#/*`,
  tsconfig `paths`, workspace packages by name) and computes each file's
  reach with the shortest chain. Type-only imports don't count. Results are
  kept per commit.
- The commit page's loader starts the scan of the commit and its first
  parent without waiting for it; the page streams it in: a "New reach"
  panel under the commit header, and reach chips on each file's header.
  A failed or too-large scan (over 5000 source files) says so instead.

## Left to the builder

The exact module lists, the chips' styling, and how many files a group
lists before folding the rest.
