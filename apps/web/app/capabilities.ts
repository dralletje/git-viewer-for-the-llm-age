import type { GlobalUse, Import } from "@room/syntax";

/**
 * What code can reach outside the program. A file that reaches none of
 * these can only compute: what it does stays inside the process.
 *
 * Decided here, from what @room/syntax finds in the code (imports and uses
 * of globals): the syntax package says what the code mentions, this says
 * what that means.
 */
export type Capability = "filesystem" | "network" | "process" | "env" | "database" | "eval";

/** Every capability, in the order they're shown. */
export const allCapabilities: Array<Capability> = ["network", "database", "filesystem", "process", "eval", "env"];

/**
 * One place a file reaches a capability itself: by importing a module that
 * gives it (`import pg from "pg"`) or by using a global (`fetch(...)`,
 * `process.env`).
 */
export type DirectCapability = {
  capability: Capability;
  kind: "module" | "global";
  /** For people: the module ("pg", "node:fs") or the global as written ("fetch()", "process.env"). */
  via: string;
  /** 1-based. */
  line: number;
};

/**
 * Modules that give a capability, by package name (a subpath counts as its
 * package: "fs/promises" is "fs", "drizzle-orm/pg-core" is "drizzle-orm").
 * `node:` and `bun:` are dropped before looking: "node:fs" is "fs". The
 * scan doesn't look inside packages, so a package counts by what it's for.
 */
const modules: Record<Capability, Array<string>> = {
  filesystem: ["fs", "graceful-fs", "fs-extra", "glob", "fast-glob", "globby", "chokidar", "rimraf", "mkdirp", "tmp", "tempy", "del", "write-file-atomic"],
  network: [
    "http",
    "https",
    "http2",
    "net",
    "tls",
    "dgram",
    "dns",
    "undici",
    "axios",
    "node-fetch",
    "cross-fetch",
    "isomorphic-fetch",
    "got",
    "ky",
    "superagent",
    "ws",
    "socket.io",
    "socket.io-client",
    "nodemailer",
    "openai",
    "stripe",
    "twilio",
    "graphql-request",
    "@anthropic-ai/sdk",
    "@ngrok/ngrok",
    "@apollo/client",
    "@trpc/client",
    "@medplum/core",
  ],
  process: ["child_process", "execa", "cross-spawn", "shelljs", "zx", "cluster"],
  env: ["dotenv"],
  database: [
    "pg",
    "postgres",
    "mysql",
    "mysql2",
    "sqlite",
    "sqlite3",
    "better-sqlite3",
    "mongodb",
    "mongoose",
    "redis",
    "ioredis",
    "knex",
    "kysely",
    "drizzle-orm",
    "typeorm",
    "sequelize",
    "@prisma/client",
    "@neondatabase/serverless",
    "@planetscale/database",
    "@libsql/client",
    "@vercel/postgres",
    "@upstash/redis",
    "@supabase/supabase-js",
  ],
  eval: ["vm"],
};

/** Scopes whose every package gives a capability: cloud SDKs talk to their service. */
const scopes: Record<string, Capability> = {
  "@aws-sdk": "network",
  "@google-cloud": "network",
  "@azure": "network",
  "@sendgrid": "network",
  "@slack": "network",
};

const capabilityOfPackage = new Map<string, Capability>(
  Object.entries(modules).flatMap(([capability, names]) => names.map((name) => [name, capability as Capability] as const)),
);

/**
 * The capability importing a module gives, by its name; null for a relative
 * path, an alias or a package that gives none.
 */
export function capabilityOfModule(specifier: string): Capability | null {
  const name = specifier.replace(/^(node|bun):/, "");
  if (name.startsWith(".") || name.startsWith("/") || name.startsWith("#")) return null;
  const parts = name.split("/");
  const scope = parts[0] ?? "";
  const packageName = scope.startsWith("@") ? parts.slice(0, 2).join("/") : scope;
  return capabilityOfPackage.get(packageName) ?? scopes[scope] ?? null;
}

/** Globals that are called: `fetch(url)`, `eval(code)`. */
const calledGlobals: Record<string, Capability> = { fetch: "network", eval: "eval", Function: "eval" };
/** Globals that are constructed: `new WebSocket(url)`. */
const constructedGlobals: Record<string, Capability> = {
  Function: "eval",
  WebSocket: "network",
  XMLHttpRequest: "network",
  EventSource: "network",
};
/** `object.property` on a global object: `process.env`, `Bun.spawn`, `Deno.readFile`. */
const globalMembers: Record<string, Record<string, Capability>> = {
  process: { env: "env" },
  "import.meta": { env: "env" },
  navigator: { sendBeacon: "network" },
  Bun: {
    env: "env",
    spawn: "process",
    spawnSync: "process",
    $: "process",
    file: "filesystem",
    write: "filesystem",
    serve: "network",
    connect: "network",
    listen: "network",
    sql: "database",
    SQL: "database",
    redis: "database",
    RedisClient: "database",
  },
  Deno: {
    env: "env",
    Command: "process",
    run: "process",
    readFile: "filesystem",
    readTextFile: "filesystem",
    writeFile: "filesystem",
    writeTextFile: "filesystem",
    open: "filesystem",
    remove: "filesystem",
    mkdir: "filesystem",
    readDir: "filesystem",
    connect: "network",
    listen: "network",
    serve: "network",
    openKv: "database",
  },
};

/** The capability a use of a global gives, with how it's shown; null when it gives none. */
export function capabilityOfGlobal(use: GlobalUse): { capability: Capability; via: string } | null {
  if (use.kind === "call") {
    const capability = calledGlobals[use.name];
    return capability === undefined ? null : { capability, via: `${use.name}()` };
  }
  if (use.kind === "new") {
    const capability = constructedGlobals[use.name];
    return capability === undefined ? null : { capability, via: `new ${use.name}()` };
  }
  const capability = use.property === null ? undefined : globalMembers[use.name]?.[use.property];
  return capability === undefined ? null : { capability, via: `${use.name}.${use.property}` };
}

/**
 * Where code reaches a capability itself, in the order of its lines: one
 * entry per module or global, at its first use. Type-only imports give
 * nothing (they're gone after compiling).
 */
export function directCapabilities(imports: Array<Import>, globals: Array<GlobalUse>): Array<DirectCapability> {
  const found: Array<DirectCapability> = [];
  for (const entry of imports) {
    if (entry.typeOnly) continue;
    const capability = capabilityOfModule(entry.source);
    if (capability !== null) found.push({ capability, kind: "module", via: entry.source, line: entry.line });
  }
  for (const use of globals) {
    const global = capabilityOfGlobal(use);
    if (global !== null) found.push({ ...global, kind: "global", line: use.line });
  }
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.line - b.line)
    .filter((entry) => {
      const key = `${entry.capability}\0${entry.via}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
