import { fetchMissingBlobs, listFiles, readBlobs, type Repository } from "@room/git";
import { languageForPath, scanSource, type SourceScan } from "@room/syntax";
import { allCapabilities, directCapabilities } from "#/capabilities.ts";
import type { Point } from "#/points.ts";
import { readPoints } from "#/points.server.ts";
import { computeReach, createResolver, parseJsonc, type ReachStep, type ReachTarget, type RepositoryReach, type ScannedFile } from "#/reach.ts";
import { ignoredBy, readIgnoreRules } from "#/rules.server.ts";

/** Past this many source files, a repository isn't scanned: the first scan would take too long to wait for. */
const maxSourceFiles = 5000;
/** A file this large is a bundle or generated: not scanned. */
const maxFileSize = 1_000_000;
/** How many files a group of new reach lists; the rest are counted. */
const maxListed = 30;

/**
 * What a commit changes about what the repository's files can reach, as its
 * page shows it. A target is a capability, or one of the repository's
 * points (see points.ts) as "point:<name>": the points come first, and
 * take over the capabilities their code and packages would give.
 */
export type ChangesReach =
  | {
      status: "scanned";
      /** How many source files the commit's tree has. */
      scanned: number;
      /** The repository's points: what each is, for the chips' hover. */
      points: Array<{ name: string; about: string | null }>;
      /** Each changed file's reach after the commit (none: it reaches nothing), and whether it's new. */
      files: Record<string, Array<{ target: ReachTarget; isNew: boolean; chain: Array<MarkedStep> }>>;
      /**
       * Files that reach a target they didn't before, in any file of the
       * repository, grouped by what gives it to them: the module, global or
       * point's code at the end of their chains. Set-aside files (tests,
       * stories, the `.room.toml`'s) are left out.
       */
      gained: Array<ReachGroup>;
      /** Per target, how many files no longer reach it. */
      lost: Array<{ target: ReachTarget; count: number }>;
    }
  | { status: "too-large"; sourceFiles: number }
  | { status: "failed"; message: string };

/**
 * A step of a chain, and whether the commit added it: an import (of that
 * name) the file didn't have before, or a module or global it didn't use.
 * In a file the commit added, every step is new.
 */
export type MarkedStep = ReachStep & { isNew: boolean };

export type ReachGroup = {
  target: ReachTarget;
  /** The last step: the file that reaches it itself, and the module or global. */
  origin: MarkedStep;
  /**
   * The imports the commit added on the way, in any of the files' chains:
   * what to read when the origin itself isn't new. None, with an old
   * origin: code that was there now uses an import that was there.
   */
  newImports: Array<ReachStep>;
  /** The files that gained it this way, the origin's own file first, each with its chain; at most `maxListed`. */
  files: Array<{ path: string; chain: Array<MarkedStep> }>;
  /** How many there are in all. */
  count: number;
};

/**
 * What a change does to reach: the whole repository scanned at `head` and
 * at `base` (null: nothing before, as for a first commit), compared. Both
 * are anything git can list the files of: a commit, or a tree (the work
 * tree's changes are a tree). `files` are the changed files, whose reach
 * the page shows beside them. Never throws: a scan that fails says so, and
 * the page shows the rest.
 */
export async function changesReach(repository: Repository, change: { head: string; base: string | null; files: Array<{ path: string }> }): Promise<ChangesReach> {
  try {
    const [afterScan, beforeScan, { points }, { rules }] = await Promise.all([
      scanRepository(repository, change.head),
      change.base === null ? null : scanRepository(repository, change.base),
      readPoints(repository),
      readIgnoreRules(repository),
    ]);
    if (afterScan.status === "too-large") return afterScan;
    if (beforeScan?.status === "too-large") return beforeScan;
    const after = { ...afterScan, reach: reachOfScan(afterScan, points) };
    const before = beforeScan === null ? null : { ...beforeScan, reach: reachOfScan(beforeScan, points) };
    // The points first, then the capabilities: the order everything is listed in.
    const targets: Array<ReachTarget> = [...points.map((point): ReachTarget => `point:${point.name}`), ...allCapabilities];
    const beforeReach: RepositoryReach = before?.reach ?? new Map();
    const reaches = (path: string, target: ReachTarget, reach: RepositoryReach) => reach.get(path)?.has(target) ?? false;

    /** Whether the parent had this step: the import (of that name), or the module or global it ends at. */
    const isNewStep = (step: ReachStep): boolean => {
      const previous = before?.files.get(step.path);
      if (previous === undefined) return true;
      const imported = previous.imports.some(
        (entry) =>
          entry.source === step.via &&
          !entry.typeOnly &&
          (step.name === null || entry.bindings.some((binding) => binding.imported === step.name && !binding.typeOnly)),
      );
      if (imported) return false;
      return !directCapabilities(previous.imports, previous.globals).some((direct) => direct.via === step.via);
    };
    const mark = (chain: Array<ReachStep>): Array<MarkedStep> => chain.map((step) => ({ ...step, isNew: isNewStep(step) }));

    const files: Extract<ChangesReach, { status: "scanned" }>["files"] = {};
    for (const { path } of change.files) {
      const theirs = after.reach.get(path);
      if (theirs === undefined) continue;
      files[path] = targets
        .filter((target) => theirs.has(target))
        .map((target) => ({ target, isNew: !reaches(path, target, beforeReach), chain: mark(theirs.get(target) ?? []) }));
    }

    const groups = new Map<string, ReachGroup>();
    for (const [path, theirs] of after.reach) {
      if (ignoredBy([path], rules) !== null) continue;
      for (const [target, chain] of theirs) {
        if (reaches(path, target, beforeReach)) continue;
        const marked = mark(chain);
        const origin = marked[marked.length - 1];
        if (origin === undefined) continue;
        const key = `${target}\0${origin.path}\0${origin.via}`;
        const group = groups.get(key) ?? { target, origin, newImports: [], files: [], count: 0 };
        for (const step of marked.slice(0, -1)) {
          if (step.isNew && !group.newImports.some((known) => known.path === step.path && known.line === step.line)) {
            group.newImports.push({ path: step.path, line: step.line, via: step.via, name: step.name });
          }
        }
        group.files.push({ path, chain: marked });
        group.count++;
        groups.set(key, group);
      }
    }
    const gained = [...groups.values()]
      .map((group) => ({
        ...group,
        newImports: group.newImports.slice(0, 5),
        // The origin's own file first, then the nearest files: shortest chains first.
        files: group.files.sort((a, b) => a.chain.length - b.chain.length || a.path.localeCompare(b.path)).slice(0, maxListed),
      }))
      .sort((a, b) => targets.indexOf(a.target) - targets.indexOf(b.target) || b.count - a.count);

    const lost = targets
      .map((target) => ({
        target,
        count: [...beforeReach].filter(([path, theirs]) => theirs.has(target) && !reaches(path, target, after.reach) && ignoredBy([path], rules) === null).length,
      }))
      .filter((entry) => entry.count > 0);

    return { status: "scanned", scanned: after.sourceFiles, points: points.map((point) => ({ name: point.name, about: point.about })), files, gained, lost };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

export type RepositoryScan =
  | {
      status: "scanned";
      sourceFiles: number;
      files: Map<string, ScannedFile>;
      /** The file an import in `from` points at; null for a package or what isn't in the tree. */
      resolve: (from: string, specifier: string) => string | null;
      /** Each source file's blob: what its contents are read by. */
      blobs: Map<string, string>;
      /** The repository's packages: each folder with a package.json ("" for the root), and the name it gives, if any. */
      packages: Array<{ dir: string; name: string | null }>;
    }
  | { status: "too-large"; sourceFiles: number };

/** Scans of whole commits, the last 10: the commit page scans a commit and its parent, and the next commit down shares one. */
const scans = new Map<string, Promise<RepositoryScan>>();
/** Each blob's imports and capabilities: a blob never changes, and consecutive commits share almost all of theirs. */
const blobScans = new Map<string, SourceScan>();

/** Every source file in the commit, scanned, and what each reaches. Kept: the reach and the graphs share it. */
export function scanRepository(repository: Repository, sha: string): Promise<RepositoryScan> {
  const key = `${repository.directory}\0${sha}`;
  const kept = scans.get(key);
  if (kept !== undefined) {
    scans.delete(key);
    scans.set(key, kept);
    return kept;
  }

  const result = (async (): Promise<RepositoryScan> => {
    const tree = await listFiles(repository, sha);
    const sources = tree.flatMap((file) => {
      const language = languageForPath(file.path);
      return language === null || file.path.includes("node_modules/") ? [] : [{ ...file, language }];
    });
    if (sources.length > maxSourceFiles) return { status: "too-large", sourceFiles: sources.length };
    const configFiles = tree.filter((file) => /(^|\/)(package|tsconfig|jsconfig)\.json$/.test(file.path) && !file.path.includes("node_modules/"));

    const unscanned = sources.filter((file) => !blobScans.has(`${file.language}:${file.blob}`));
    const toRead = [...unscanned.map((file) => file.blob), ...configFiles.map((file) => file.blob)];
    await fetchMissingBlobs(repository, sha, toRead);
    const contents = await readBlobs(repository, toRead);

    for (const file of unscanned) {
      const source = contents.get(file.blob);
      const scan = source === undefined || source.length > maxFileSize ? { imports: [], globals: [], localExports: null, module: null } : await scanSource(file.language, source);
      remember(blobScans, `${file.language}:${file.blob}`, scan, 100_000);
    }

    const scanned: Array<ScannedFile> = sources.map((file) => ({
      path: file.path,
      ...(blobScans.get(`${file.language}:${file.blob}`) ?? { imports: [], globals: [], localExports: null, module: null }),
    }));
    const configs = new Map(configFiles.flatMap((file) => {
      const text = contents.get(file.blob);
      return text === undefined ? [] : [[file.path, text] as const];
    }));
    const resolve = createResolver(
      tree.map((file) => file.path),
      configs,
    );
    return {
      status: "scanned",
      sourceFiles: sources.length,
      files: new Map(scanned.map((file) => [file.path, file])),
      resolve,
      blobs: new Map(sources.map((file) => [file.path, file.blob])),
      packages: [...configs]
        .filter(([path]) => path === "package.json" || path.endsWith("/package.json"))
        .map(([path, text]) => {
          const json = parseJsonc(text);
          const name = json !== null && typeof json === "object" && "name" in json && typeof json.name === "string" ? json.name : null;
          return { dir: path === "package.json" ? "" : path.slice(0, -"/package.json".length), name };
        }),
    };
  })();

  remember(scans, key, result, 10);
  // A failed scan isn't kept: the next page load tries again.
  result.catch(() => scans.delete(key));
  return result;
}

/**
 * Each scan's reach, per set of points: the scans are kept (the last 10), and
 * so is this, beside them. The points are the work tree's (see readPoints),
 * so an edit to `.room.toml` computes it again.
 */
const reachOfScans = new WeakMap<object, Map<string, RepositoryReach>>();
function reachOfScan(scan: Extract<RepositoryScan, { status: "scanned" }>, points: Array<Point>): RepositoryReach {
  const key = JSON.stringify(points);
  const kept = reachOfScans.get(scan) ?? new Map<string, RepositoryReach>();
  reachOfScans.set(scan, kept);
  const found = kept.get(key);
  if (found !== undefined) return found;
  const reach = computeReach([...scan.files.values()], scan.resolve, points);
  // Only the latest points matter: an older set is from before an edit.
  kept.clear();
  kept.set(key, reach);
  return reach;
}

/** Least recently used goes first: a Map keeps insertion order. */
function remember<Value>(cache: Map<string, Value>, key: string, value: Value, limit: number): void {
  cache.set(key, value);
  if (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}
