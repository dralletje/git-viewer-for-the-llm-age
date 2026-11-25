import { dirname, join, matchesGlob, normalize } from "node:path/posix";
import type { Import, LocalExports, ModuleGraph, SourceScan } from "@room/syntax";
import { allCapabilities, capabilityOfGlobal, capabilityOfModule, directCapabilities, type Capability } from "#/capabilities.ts";
import { pointOfDeclaration, pointOfPackage, type Point } from "#/points.ts";

/** One file of the repository, scanned (see @room/syntax's `scanSource`). */
export type ScannedFile = SourceScan & { path: string };

/**
 * One step of how a file reaches a capability: in `path`, on `line`, `via`
 * is the import (a specifier, "./db.ts") that leads to the next step, or, on
 * the last step, the module or global that gives the capability ("pg",
 * "fetch()"). `name`: the name it imports (`openRepository`), when it
 * imports one by name.
 */
export type ReachStep = { path: string; line: number; via: string; name: string | null };

/**
 * What a file can reach: a capability, or one of the repository's points
 * (see points.ts), as "point:<name>".
 */
export type ReachTarget = Capability | `point:${string}`;

/** For each file, each target it reaches, by the shortest chain of imports; direct use is a chain of one step. */
export type RepositoryReach = Map<string, Map<ReachTarget, Array<ReachStep>>>;

/** Extensions a TS/JS import can leave out, in the order TypeScript tries them. */
const extensions = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
/** `./a.js` in TypeScript source means `./a.ts` (or `.tsx`): what it compiles to. */
const compiledExtensions: Record<string, Array<string>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

type PackageJson = { dir: string; name: string | null; imports: unknown; exports: unknown; main: string | null };
type PathsConfig = { dir: string; baseUrl: string; paths: Array<{ pattern: string; targets: Array<string> }> };

/**
 * Finds the file an import points at, the way TypeScript and Node would on
 * this tree: relative paths (with left-out extensions, `.js` for `.ts`,
 * `index` files), package.json `imports` (`#/*`), tsconfig `paths` (`@/*`),
 * and the repository's own packages by name. Null: a package from outside
 * the repository, or nothing it can find.
 *
 * `configs` holds the contents of the tree's package.json and tsconfig.json
 * files, by path. It reads them as they are: a tsconfig's `extends` isn't
 * followed.
 */
export function createResolver(paths: Iterable<string>, configs: Map<string, string>): (from: string, specifier: string) => string | null {
  const files = new Set(paths);
  const packages = new Map<string, PackageJson>();
  const packagesByName = new Map<string, PackageJson>();
  const pathsConfigs = new Map<string, PathsConfig>();

  for (const [path, text] of configs) {
    const dir = dirname(path);
    const parsed = parseJsonc(text);
    if (parsed === null || typeof parsed !== "object") continue;
    const json = parsed as Record<string, unknown>;
    if (path === "package.json" || path.endsWith("/package.json")) {
      const entry: PackageJson = {
        dir,
        name: typeof json.name === "string" ? json.name : null,
        imports: json.imports ?? null,
        exports: json.exports ?? null,
        main: typeof json.main === "string" ? json.main : null,
      };
      packages.set(dir, entry);
      if (entry.name !== null) packagesByName.set(entry.name, entry);
    } else {
      const options = (json.compilerOptions ?? {}) as Record<string, unknown>;
      if (options.paths === undefined || typeof options.paths !== "object" || options.paths === null) continue;
      pathsConfigs.set(dir, {
        dir,
        baseUrl: typeof options.baseUrl === "string" ? options.baseUrl : ".",
        paths: Object.entries(options.paths as Record<string, unknown>).map(([pattern, targets]) => ({
          pattern,
          targets: Array.isArray(targets) ? targets.filter((target): target is string => typeof target === "string") : [],
        })),
      });
    }
  }

  /** The file a path means: itself, with an extension added or swapped, or its folder's index. */
  const file = (path: string): string | null => {
    const base = normalize(path).replace(/^\.\/|\/$/g, "");
    if (base.startsWith("../")) return null;
    if (files.has(base)) return base;
    for (const [compiled, sources] of Object.entries(compiledExtensions)) {
      if (!base.endsWith(compiled)) continue;
      for (const source of sources) {
        const candidate = base.slice(0, -compiled.length) + source;
        if (files.has(candidate)) return candidate;
      }
    }
    for (const extension of extensions) {
      if (files.has(base + extension)) return base + extension;
    }
    for (const extension of extensions) {
      const index = base === "" || base === "." ? `index${extension}` : `${base}/index${extension}`;
      if (files.has(index)) return index;
    }
    return null;
  };

  /** The nearest config in `from`'s folder or above it, as `configs` keeps them by folder. */
  const nearest = <Config>(from: string, byDir: Map<string, Config>, has: (config: Config) => boolean): Config | null => {
    let dir = dirname(from);
    for (;;) {
      const config = byDir.get(dir);
      if (config !== undefined && has(config)) return config;
      if (dir === "." || dir === "/" || dir === "") return null;
      dir = dirname(dir);
    }
  };

  /** A package's entry for a subpath ("." or "./utils"), through `exports`, else `main` or its index. */
  const packageEntry = (entry: PackageJson, subpath: string): string | null => {
    const target = entry.exports === null ? null : matchMap(entry.exports, subpath, true);
    if (target !== null) return file(join(entry.dir, target));
    if (subpath === ".") {
      if (entry.main !== null) {
        const main = file(join(entry.dir, entry.main));
        if (main !== null) return main;
      }
      return file(join(entry.dir, "index")) ?? file(join(entry.dir, "src/index"));
    }
    return file(join(entry.dir, subpath));
  };

  return (from, specifier) => {
    if (specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..") {
      return file(join(dirname(from), specifier));
    }
    if (specifier.startsWith("/")) return null;

    if (specifier.startsWith("#")) {
      const entry = nearest(from, packages, (config) => config.imports !== null);
      const target = entry === null ? null : matchMap(entry.imports, specifier, false);
      return entry === null || target === null ? null : file(join(entry.dir, target));
    }

    const config = nearest(from, pathsConfigs, () => true);
    if (config !== null) {
      for (const { pattern, targets } of config.paths) {
        const star = matchPattern(pattern, specifier);
        if (star === null) continue;
        for (const target of targets) {
          const found = file(join(config.dir, config.baseUrl, target.replace("*", star)));
          if (found !== null) return found;
        }
      }
    }

    const parts = specifier.split("/");
    const nameLength = specifier.startsWith("@") ? 2 : 1;
    const entry = packagesByName.get(parts.slice(0, nameLength).join("/"));
    if (entry !== undefined) {
      const rest = parts.slice(nameLength).join("/");
      return packageEntry(entry, rest === "" ? "." : `./${rest}`);
    }
    return null;
  };
}

/**
 * The target a package.json `imports` or `exports` map gives a key, with `*`
 * patterns. A target can be conditions (`{ "import": ..., "default": ... }`):
 * the first that ends in a path counts. `exports` may also be just the
 * entry itself (a string, or conditions without "./" keys).
 */
function matchMap(map: unknown, key: string, isExports: boolean): string | null {
  if (typeof map === "string") return isExports && key === "." ? map : null;
  if (map === null || typeof map !== "object") return null;
  const entries = Object.entries(map as Record<string, unknown>);
  if (isExports && entries.every(([name]) => !name.startsWith("."))) {
    return key === "." ? conditionTarget(map) : null;
  }
  for (const [pattern, target] of entries) {
    const star = matchPattern(pattern, key);
    if (star === null) continue;
    const path = conditionTarget(target);
    if (path !== null) return path.replace("*", star);
  }
  return null;
}

function conditionTarget(target: unknown): string | null {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const option of target) {
      const found = conditionTarget(option);
      if (found !== null) return found;
    }
    return null;
  }
  if (target === null || typeof target !== "object") return null;
  for (const [condition, value] of Object.entries(target as Record<string, unknown>)) {
    // Types point at declarations, which don't run.
    if (condition === "types") continue;
    const found = conditionTarget(value);
    if (found !== null) return found;
  }
  return null;
}

/** What `*` stands for when `pattern` matches `value` ("" for an exact match); null when it doesn't. */
function matchPattern(pattern: string, value: string): string | null {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === value ? "" : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (value.length < prefix.length + suffix.length || !value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  return value.slice(prefix.length, value.length - suffix.length);
}

/** JSON with comments and trailing commas, as tsconfig.json allows; null when it isn't. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const end = endOfString(text, index);
      out += text.slice(index, end);
      index = end;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      out += char;
      index++;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

/** The index just after the string that starts at `start` (its opening quote). */
function endOfString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") index += 2;
    else if (text[index] === '"') return index + 1;
    else index++;
  }
  return text.length;
}

/**
 * What every file reaches, through any number of imports, followed name by
 * name through the code: importing `parse` from a file reaches what the
 * code of `parse` reaches, and what that code uses in turn (in its own file
 * and through its imports), not what the rest of the file reaches. Types
 * don't count: they're gone when the code runs.
 *
 * The graph's nodes, per file:
 * - a unit: a top-level declaration or statement (see @room/syntax's
 *   module graph). It reaches what its globals give, what the modules it
 *   `require`s give, and what the names it uses reach.
 * - an imported name: what the code it names in the other file reaches,
 *   past files that only pass it on (barrels); a package's name gives what
 *   the package gives (`import { Pool } from "pg"`).
 * - load: what loading the file runs: its top-level statements, and the
 *   loads of the files it imports. Importing any name from a file loads it.
 * - all: everything the file's code can reach, its re-exports included:
 *   what its chips show, and what `import * as x`, `require` and
 *   `import()` of it lead to.
 * A file without a module graph (it couldn't be parsed, or it's CommonJS,
 * whose exports aren't known from syntax) counts as a whole.
 *
 * Each target keeps the shortest chain (breadth first, from where it's
 * reached back along the edges); steps within a file aren't in the chain,
 * which lists the imports that lead to the code that reaches it.
 *
 * The repository's `points` are targets too: a point's code (its files,
 * its declarations) reaches it, and so does importing from a package it
 * names. They come first: a package a point names gives that point, not
 * its capability (Twilio's package isn't "network"), and a point's own
 * code is a wall: what's past it is that point, so a capability or another
 * point isn't reached through it.
 */
export function computeReach(files: Array<ScannedFile>, resolve: (from: string, specifier: string) => string | null, points: Array<Point> = []): RepositoryReach {
  const byPath = new Map(files.map((scanned) => [scanned.path, scanned]));
  const all = (path: string) => `${path}\0all`;
  const load = (path: string) => `${path}\0load`;
  const unit = (path: string, index: number) => `${path}\0unit\0${index}`;
  const imported = (path: string, local: string) => `${path}\0import\0${local}`;
  const external = (path: string, entry: Import) => `${path}\0external\0${entry.line}\0${entry.source}`;
  /** Files whose names can be followed one by one; the rest count as a whole. */
  const followed = (scanned: ScannedFile | undefined): scanned is ScannedFile & { module: ModuleGraph; localExports: LocalExports } =>
    scanned !== undefined && scanned.module !== null && scanned.localExports !== null;

  /**
   * The nodes a name exported by `path` leads to: its code, where the
   * re-exports passing it on end, and the loads of the files on the way.
   * Null when the file doesn't export the name (as far as its syntax tells).
   */
  const definers = (path: string, name: string, seen: Set<string>): Array<string> | null => {
    const key = `${path}\0${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const scanned = byPath.get(path);
    if (!followed(scanned)) return [all(path)];
    // A type: nothing runs.
    if (scanned.localExports.types.includes(name)) return [];
    const own = scanned.module.exports.find((entry) => entry.name === name);
    if (own !== undefined) return ["unit" in own ? unit(path, own.unit) : imported(path, own.imported), load(path)];

    const reExports = scanned.imports.filter((entry) => entry.kind === "re-export");
    for (const entry of reExports) {
      for (const binding of entry.bindings) {
        if (binding.local !== name || (binding.imported === "*" && binding.local === "*")) continue;
        if (entry.typeOnly || binding.typeOnly) return [];
        const target = resolve(path, entry.source);
        if (target === null) return [external(path, entry), load(path)];
        if (binding.imported === "*") return [all(target), load(path)];
        return [...(definers(target, binding.imported, seen) ?? [all(target)]), load(path)];
      }
    }
    // `export * from "x"` passes on every name x has, but not its default.
    if (name === "default") return null;
    for (const entry of reExports.filter((entry) => !entry.typeOnly)) {
      if (!entry.bindings.some((binding) => binding.imported === "*" && binding.local === "*")) continue;
      const target = resolve(path, entry.source);
      if (target === null) continue;
      const found = definers(target, name, seen);
      if (found !== null) return [...found, load(path)];
    }
    return null;
  };
  /** Not found: the whole file, to be safe (an `export *` from a package, ...). */
  const definersOf = (path: string, name: string) => definers(path, name, new Set()) ?? [all(path)];

  /** For each node, the nodes that lead to it, with the import that does (null: within a file). */
  const leadsTo = new Map<string, Array<{ node: string; step: ReachStep | null }>>();
  const link = (from: string, to: string, step: ReachStep | null) => {
    const list = leadsTo.get(to) ?? [];
    list.push({ node: from, step });
    leadsTo.set(to, list);
  };
  /** Where each target is reached directly: the node, and the one step that is the chain. */
  const seeds: Array<{ node: string; capability: ReachTarget; step: ReachStep }> = [];
  const seedModule = (node: string, path: string, line: number, source: string, name: string | null) => {
    // A package a point names gives the point, not its capability.
    const point = pointOfPackage(points, source);
    if (point !== null) {
      seeds.push({ node, capability: `point:${point}`, step: { path, line, via: source, name } });
      return;
    }
    const capability = capabilityOfModule(source);
    if (capability !== null) seeds.push({ node, capability, step: { path, line, via: source, name } });
  };

  /** The nodes that are a point's own code, and which point: no other target is reached through them. */
  const memberOf = new Map<string, ReachTarget>();
  /** A file a point names: all of it is the point. */
  const pointOfFile = (path: string): string | null => points.find((point) => point.files.some((pattern) => matchesGlob(path, pattern)))?.name ?? null;

  for (const scanned of files) {
    const path = scanned.path;
    link(all(path), load(path), null);

    // A point's code: what it declares reaches the point, itself the step.
    const filePoint = pointOfFile(path);
    if (filePoint !== null) {
      for (const node of [all(path), load(path)]) memberOf.set(node, `point:${filePoint}`);
      if (!followed(scanned)) seeds.push({ node: load(path), capability: `point:${filePoint}`, step: { path, line: 1, via: path, name: null } });
    }
    if (followed(scanned)) {
      scanned.module.units.forEach((code, index) => {
        const point = filePoint ?? pointOfDeclaration(points, path, code.names.join(", "));
        if (point === null) return;
        memberOf.set(unit(path, index), `point:${point}`);
        seeds.push({ node: unit(path, index), capability: `point:${point}`, step: { path, line: code.startLine, via: code.names.join(", ") || path, name: null } });
      });
    }

    if (!followed(scanned)) {
      // As a whole: everything it reaches, it reaches on load.
      for (const direct of directCapabilities(scanned.imports, scanned.globals)) {
        seeds.push({ node: load(path), capability: direct.capability, step: { path, line: direct.line, via: direct.via, name: null } });
      }
      for (const entry of scanned.imports) {
        if (entry.typeOnly) continue;
        const target = resolve(path, entry.source);
        if (target !== null && target !== path) link(load(path), all(target), { path, line: entry.line, via: entry.source, name: null });
      }
      continue;
    }

    const names = new Map<string, string>();
    scanned.module.units.forEach((code, index) => {
      for (const name of code.names) names.set(name, unit(path, index));
    });
    for (const entry of scanned.imports) {
      if (entry.kind !== "import" || entry.typeOnly) continue;
      for (const binding of entry.bindings) if (!binding.typeOnly) names.set(binding.local, imported(path, binding.local));
    }

    scanned.module.units.forEach((code, index) => {
      const node = unit(path, index);
      link(all(path), node, null);
      if (code.onLoad) link(load(path), node, null);
      for (const name of code.uses) {
        const target = names.get(name);
        if (target !== undefined && target !== node) link(node, target, null);
      }
      for (const use of code.globals) {
        const global = capabilityOfGlobal(use);
        if (global !== null) seeds.push({ node, capability: global.capability, step: { path, line: use.line, via: global.via, name: null } });
      }
      for (const loaded of code.loads) {
        const target = resolve(path, loaded.source);
        if (target === null) seedModule(node, path, loaded.line, loaded.source, null);
        else if (target !== path) link(node, all(target), { path, line: loaded.line, via: loaded.source, name: null });
      }
    });

    for (const entry of scanned.imports) {
      if (entry.typeOnly || (entry.kind !== "import" && entry.kind !== "re-export")) continue;
      const bindings = entry.bindings.filter((binding) => !binding.typeOnly);
      // `import { type A } from "x"`: only types, gone when compiled.
      if (entry.bindings.length > 0 && bindings.length === 0) continue;
      const target = resolve(path, entry.source);
      if (target === path) continue;
      const step = (name: string | null): ReachStep => ({ path, line: entry.line, via: entry.source, name });
      // Loading this file loads the ones it imports.
      if (target !== null) link(load(path), load(target), step(null));

      if (entry.kind === "re-export") {
        if (target === null) {
          link(all(path), external(path, entry), null);
          seedModule(external(path, entry), path, entry.line, entry.source, null);
          continue;
        }
        for (const binding of bindings) {
          const nodes = binding.imported === "*" ? [all(target)] : definersOf(target, binding.imported);
          for (const node of nodes) link(all(path), node, step(binding.imported === "*" ? null : binding.imported));
        }
        continue;
      }

      // `import "x"`: run for what loading it does.
      if (bindings.length === 0 && target === null) seedModule(load(path), path, entry.line, entry.source, null);
      for (const binding of bindings) {
        const node = imported(path, binding.local);
        link(all(path), node, null);
        if (target === null) {
          seedModule(node, path, entry.line, entry.source, binding.imported === "*" ? null : binding.imported);
        } else if (binding.imported === "*") {
          link(node, all(target), step(null));
        } else {
          for (const definer of definersOf(target, binding.imported)) link(node, definer, step(binding.imported));
        }
      }
    }
  }

  const reached = new Map<string, Map<ReachTarget, Array<ReachStep>>>();
  const targets: Array<ReachTarget> = [...points.map((point): ReachTarget => `point:${point.name}`), ...allCapabilities];
  for (const capability of targets) {
    const chains = new Map<string, Array<ReachStep>>();
    const queue: Array<string> = [];
    const reach = (node: string, chain: Array<ReachStep>) => {
      if (chains.has(node)) return;
      // Another point's code is a wall: past it is that point.
      const member = memberOf.get(node);
      if (member !== undefined && member !== capability) return;
      chains.set(node, chain);
      queue.push(node);
    };
    for (const seed of seeds) if (seed.capability === capability) reach(seed.node, [seed.step]);
    for (let next = 0; next < queue.length; next++) {
      const node = queue[next] ?? "";
      const chain = chains.get(node) ?? [];
      for (const from of leadsTo.get(node) ?? []) reach(from.node, from.step === null ? chain : [from.step, ...chain]);
    }
    for (const [node, chain] of chains) {
      if (!node.endsWith("\0all")) continue;
      const path = node.slice(0, -"\0all".length);
      const theirs = reached.get(path) ?? new Map<ReachTarget, Array<ReachStep>>();
      theirs.set(capability, chain);
      reached.set(path, theirs);
    }
  }
  return new Map(files.map((scanned) => [scanned.path, reached.get(scanned.path) ?? new Map()]));
}
