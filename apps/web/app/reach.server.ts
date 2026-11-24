import { fetchMissingBlobs, listFiles, readBlobs, type Repository } from "@room/git";
import { languageForPath, scanSource, type SourceScan } from "@room/syntax";
import { allCapabilities, directCapabilities, type Capability } from "#/capabilities.ts";
import { computeReach, createResolver, type ReachStep, type RepositoryReach, type ScannedFile } from "#/reach.ts";
import { ignoredBy } from "#/rules.server.ts";

/** Past this many source files, a repository isn't scanned: the first scan would take too long to wait for. */
const maxSourceFiles = 5000;
/** A file this large is a bundle or generated: not scanned. */
const maxFileSize = 1_000_000;
/** How many files a group of new reach lists; the rest are counted. */
const maxListed = 30;

/** What a commit changes about what the repository's files can reach, as its page shows it. */
export type CommitReach =
  | {
      status: "scanned";
      /** How many source files the commit's tree has. */
      scanned: number;
      /** Each changed file's reach after the commit (none: it reaches nothing), and whether it's new. */
      files: Record<string, Array<{ capability: Capability; isNew: boolean; chain: Array<MarkedStep> }>>;
      /**
       * Files that reach a capability they didn't before, in any file of
       * the repository, grouped by what gives it to them: the module or
       * global at the end of their chains. Tests and stories are left out.
       */
      gained: Array<ReachGroup>;
      /** Per capability, how many files no longer reach it. */
      lost: Array<{ capability: Capability; count: number }>;
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
  capability: Capability;
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
 * What the commit changes about reach: the whole repository scanned at the
 * commit and at its first parent (nothing before a first commit), compared.
 * Never throws: a scan that fails says so, and the page shows the rest.
 */
export async function commitReach(repository: Repository, commit: { sha: string; parents: Array<string>; files: Array<{ path: string }> }): Promise<CommitReach> {
  try {
    const parent = commit.parents[0];
    const [after, before] = await Promise.all([scanRepository(repository, commit.sha), parent === undefined ? null : scanRepository(repository, parent)]);
    if (after.status === "too-large") return after;
    if (before?.status === "too-large") return before;
    const beforeReach = before?.reach ?? new Map();
    const reaches = (path: string, capability: Capability, reach: RepositoryReach) => reach.get(path)?.has(capability) ?? false;

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

    const files: Extract<CommitReach, { status: "scanned" }>["files"] = {};
    for (const { path } of commit.files) {
      const theirs = after.reach.get(path);
      if (theirs === undefined) continue;
      files[path] = allCapabilities
        .filter((capability) => theirs.has(capability))
        .map((capability) => ({ capability, isNew: !reaches(path, capability, beforeReach), chain: mark(theirs.get(capability) ?? []) }));
    }

    const groups = new Map<string, ReachGroup>();
    for (const [path, theirs] of after.reach) {
      if (ignoredBy([path]) !== null) continue;
      for (const [capability, chain] of theirs) {
        if (reaches(path, capability, beforeReach)) continue;
        const marked = mark(chain);
        const origin = marked[marked.length - 1];
        if (origin === undefined) continue;
        const key = `${capability}\0${origin.path}\0${origin.via}`;
        const group = groups.get(key) ?? { capability, origin, newImports: [], files: [], count: 0 };
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
      .sort((a, b) => allCapabilities.indexOf(a.capability) - allCapabilities.indexOf(b.capability) || b.count - a.count);

    const lost = allCapabilities
      .map((capability) => ({
        capability,
        count: [...beforeReach].filter(([path, theirs]) => theirs.has(capability) && !reaches(path, capability, after.reach) && ignoredBy([path]) === null).length,
      }))
      .filter((entry) => entry.count > 0);

    return { status: "scanned", scanned: after.sourceFiles, files, gained, lost };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

type RepositoryScan =
  | { status: "scanned"; sourceFiles: number; files: Map<string, ScannedFile>; reach: RepositoryReach }
  | { status: "too-large"; sourceFiles: number };

/** Scans of whole commits, the last 10: the commit page scans a commit and its parent, and the next commit down shares one. */
const scans = new Map<string, Promise<RepositoryScan>>();
/** Each blob's imports and capabilities: a blob never changes, and consecutive commits share almost all of theirs. */
const blobScans = new Map<string, SourceScan>();

/** Every source file in the commit, scanned, and what each reaches. */
function scanRepository(repository: Repository, sha: string): Promise<RepositoryScan> {
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
      reach: computeReach(scanned, resolve),
    };
  })();

  remember(scans, key, result, 10);
  // A failed scan isn't kept: the next page load tries again.
  result.catch(() => scans.delete(key));
  return result;
}

/** Least recently used goes first: a Map keeps insertion order. */
function remember<Value>(cache: Map<string, Value>, key: string, value: Value, limit: number): void {
  cache.set(key, value);
  if (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}
