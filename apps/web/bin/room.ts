#!/usr/bin/env node
/**
 * room: Behind the Room, on the repositories you give it.
 *
 *   room [repository...] [--all] [--port 4800]
 *
 * A repository is a path (anywhere inside one) or a GitHub one (owner/name,
 * a github.com link); none: the one you're in. The server shows those and
 * nothing else: any other repository, local or on GitHub, is a 404. With
 * --all it shows every repository on this machine and any on GitHub.
 *
 * Starts the app on localhost, built first when its source changed since the
 * last build, and prints where to open it: the repository, when there is
 * one, else the home page with the list. Ctrl-C stops it.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GitError, openRepository, parseGithubRepository, type RepositorySource } from "@room/git";
import { repositoryPath } from "#/paths.ts";

const usage = `Usage: room [repository...] [--all] [--port 4800]

Opens Behind the Room on these repositories, and only these: paths (anywhere
inside one) or GitHub ones (owner/name). None: the one you're in.

  --all        show every repository on this machine, and any on GitHub
  --port N     listen on port N (default 4800)`;

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(web, "..", "..");

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", default: "4800" },
      all: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (error) {
  console.error(`room: ${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
  process.exit(1);
}
if (parsed.values.help === true) {
  console.log(usage);
  process.exit(0);
}
const port = Number(parsed.values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error(`room: --port takes a number from 1024 to 65535, not "${parsed.values.port}".`);
  process.exit(1);
}
const all = parsed.values.all === true;

// The repositories asked for; none: the one we're in (if any).
const asked = parsed.positionals.length > 0 ? parsed.positionals : [process.cwd()];
const repositories: Array<RepositorySource> = [];
for (const argument of asked) {
  const source = await sourceOf(argument);
  if (source === null) {
    // Not being in a repository is fine with --all: the home page lists them.
    if (parsed.positionals.length === 0 && all) break;
    console.error(
      parsed.positionals.length === 0
        ? `room: ${argument} isn't in a git repository. Name the repositories to show, or use --all.`
        : `room: ${argument} isn't a git repository here, or a GitHub one (owner/name).`,
    );
    process.exit(1);
  }
  if (!repositories.some((known) => repositoryPath(known) === repositoryPath(source))) repositories.push(source);
}

// One repository: its page. Several, or --all without one: the home page, which lists them.
const page = repositories.length === 1 && repositories[0] !== undefined ? repositoryPath(repositories[0]) : "/";

// Build when there's no build, or the source changed since.
const built = join(web, "build", "server", "index.js");
if (!existsSync(built) || newestSourceChange() > statSync(built).mtimeMs) {
  console.log("room: building (the source changed since the last build)…");
  // pnpm runs it with the Node version the workspace asks for.
  const build = spawnSync("pnpm", ["exec", "react-router", "build"], { cwd: web, stdio: ["ignore", "ignore", "inherit"] });
  if (build.status !== 0) {
    console.error("room: the build failed (see above).");
    process.exit(1);
  }
}

// Its own process group, so stopping room stops the server under pnpm too.
const server = spawn("pnpm", ["exec", "react-router-serve", "./build/server/index.js"], {
  cwd: web,
  env: {
    ...withoutKey(process.env, "ROOM_REPOSITORIES"),
    // What it may show (see app/access.server.ts); unset with --all: everything.
    ...(all ? {} : { ROOM_REPOSITORIES: JSON.stringify(repositories) }),
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
  },
  // Its stdout logs every request; errors still show.
  stdio: ["ignore", "ignore", "inherit"],
  detached: true,
});
const stop = () => {
  if (server.pid !== undefined && server.exitCode === null) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
};
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(143);
});
server.on("exit", (code) => {
  console.error(`room: the server stopped${code === null ? "" : ` (exit code ${code})`}. Is port ${port} taken? Try --port.`);
  process.exit(1);
});

// Wait until it answers, then say where to go.
const address = `http://localhost:${port}`;
for (let attempt = 0; ; attempt++) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" });
    break;
  } catch {
    if (attempt === 300) {
      console.error(`room: the server didn't answer on port ${port} within 30 seconds.`);
      stop();
      process.exit(1);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}
console.log(`Behind the Room: ${address}${page}`);
console.log(
  all
    ? "Showing every repository on this machine, and any on GitHub."
    : `Showing ${repositories.length === 1 ? "only this repository" : `only these ${repositories.length} repositories`}: ${repositories
        .map((source) => (source.kind === "local" ? source.path : `${source.owner}/${source.name}`))
        .join(", ")}`,
);
console.log("Ctrl-C stops it.");

/**
 * A path that exists: its repository (the top folder when it points inside
 * one). Otherwise a GitHub repository, when it reads as one. Null: neither.
 */
async function sourceOf(argument: string): Promise<RepositorySource | null> {
  const path = resolve(argument);
  if (existsSync(path)) {
    try {
      return (await openRepository({ kind: "local", path })).source;
    } catch (error) {
      if (error instanceof GitError) return null;
      throw error;
    }
  }
  const github = parseGithubRepository(argument);
  return github === null ? null : { kind: "github", owner: github.owner, name: github.name };
}

/** The environment without one variable: a ROOM_REPOSITORIES room inherited mustn't change what this one shows. */
function withoutKey(environment: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  const copy = { ...environment };
  delete copy[key];
  return copy;
}

/** When the app's or its packages' source last changed (ms since 1970). */
function newestSourceChange(): number {
  const folders = [join(web, "app"), ...readdirSync(join(root, "packages")).map((name) => join(root, "packages", name, "src"))];
  const files = [join(web, "vite.config.ts"), join(web, "react-router.config.ts"), join(web, "package.json")];
  for (const folder of folders) {
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder, { recursive: true })) {
      files.push(join(folder, String(name)));
    }
  }
  return Math.max(0, ...files.filter((file) => existsSync(file)).map((file) => statSync(file).mtimeMs));
}
