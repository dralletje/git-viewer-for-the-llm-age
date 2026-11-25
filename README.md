# Behind the Room

In Searle's Chinese Room, someone follows a rulebook and slides fluent
answers out through a slot, without understanding a word. An LLM writing code
is that room. This is for the person outside: reading what came out, closely
enough to tell what it means.

A git diff and commit viewer built for reading code an LLM wrote. Point it at
a GitHub repository, or at one on this machine (`~/repos/project`, any path
inside one, or a bare repository), and read its branches, commits and diffs.
On top of that it does what this project is really about:

- rules that hide or fold files you don't need to read (lockfiles, snapshots, generated code)
- AST-aware views: which functions, variables and exports a change really adds
- scanning a file's imports and structure to mark it "safe", so you know where
  your review attention matters least

A commit's page scans the whole repository, at the commit and at its
parent, for what each file can reach outside the program: the network, a
database, the file system, child processes, `eval`, env vars. Reach comes
from a module (`pg`, `node:fs`) or a global (`fetch()`, `process.env`), and
follows the code: an imported name to the code that defines it (past
barrel files that only pass it on), and on through what that code uses.
A local `fetch` isn't the global one. The page lists the files that gained
a reach, each with the chain of imports that gives it, and marks every
changed file with what it reaches, or "reaches nothing". What counts as a
capability is in `apps/web/app/capabilities.ts`, the following in
`apps/web/app/reach.ts`; `@room/syntax` provides what the code says
(imports, globals, scopes, the module graph).

Only code that runs counts: a change to types, comments or formatting is
left out of Reach, the declarations and the graph.

**Ripple** (a tab) draws what the changes spread to: each changed
declaration, and everything that uses it, through the whole repository. It
also shows the uses a change added or removed. Each file is a box inside
its app's or package's box, and uses from one app into another are drawn
thicker. The graph sticks above the code, and you can drag, scroll and zoom
it. Clicking a declaration shows only the paths through it, and only their
files below. Scrolling the code marks the declaration you're reading.

Tests and stories are set aside by the rules in
`apps/web/app/rules.server.ts` (written from mimas's conventions): they stay
listed, folded into one line per rule, and are only read when opened.

A repository can describe itself in a `.room.toml` at its root:

- **points:** what matters in it (Medplum, the database, an SMS provider),
  by package, file or declaration. Reach and Ripple show them first.
- **ignore:** more files to set aside.

The format is in [AGENTS.md](AGENTS.md).

## Use

```sh
room                              # the repository you're in
room ~/repos/a ~/repos/b owner/c  # these: paths (anywhere inside one) or GitHub ones
room --all                        # every repository on this machine, and any on GitHub
room --port 4900                  # default 4800
```

On a repository on this machine, the checked-out branch's commit list starts
with **Current changes**: what changed since the last commit (staged, not
staged and new files), shown with the same tabs as a commit. It reads the
work tree through a temporary copy of the index, so your own index stays as
it is; git only keeps the new contents as loose objects until `git gc`.

A room shows the repositories it was started with and nothing else: any
other repository, local or on GitHub, is a 404, and the home page lists only
those. `--all` lifts that (as `pnpm dev` does). `room` builds the app when
its source changed since the last build, serves it on localhost and prints
the address to open. Ctrl-C stops it. To have the command, link it
somewhere on your PATH:

```sh
ln -s "$PWD/apps/web/bin/room.ts" ~/.local/bin/room
```

## Develop

```sh
pnpm install
pnpm dev        # http://localhost:4700
pnpm test
pnpm typecheck
```

pnpm downloads the Node version set in `devEngines.runtime` (26) and runs
every script with it. Node runs the TypeScript directly, so the packages have
no build step and export their `.ts` source.

## Layout

| Path | What it is |
|---|---|
| `packages/diff` (`@room/diff`) | Parses git's unified diff into files, hunks and lines. Every later view works on this model, never on diff text. |
| `packages/git` (`@room/git`) | Talks to `git`: clones a GitHub repository (bare, blobs on demand) into `~/.cache/behind-the-room/repos` (or `$ROOM_CACHE`), lists branches and commits, and returns a commit with its parsed diff. |
| `packages/syntax` (`@room/syntax`) | tree-sitter (WASM) for TS, TSX and JS: parses a whole file once and returns its highlighted lines, imports and exports; scans a file for a whole-repository pass (`scanSource`: its uses of globals, with scopes, and its module graph); compares two versions' imports per module, and exports per name through the file's top level as a graph: an export is "changed" when its own code changed (formatting aside), "affected" when top-level code it uses did (with the path), and changes no export reaches are listed. |
| `packages/canvas` (`@room/canvas`) | A pan and zoom canvas for the graph: drag, scroll, pinch, fit. No framework. |
| `apps/web` (`@room/web`) | React Router 8 in framework mode. `route.tsx` holds the decisions; `components.tsx` next to it holds the markup and styling. |

The app clones over HTTPS with whatever git credentials the machine has, so
private repositories work when `git clone` would. A local repository is read
where it is, never fetched; its pages live under `/local/<path, URL-encoded>`.
That means anyone who can open the app can read any repository on the
machine, so keep it bound to localhost.
