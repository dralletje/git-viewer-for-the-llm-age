import { changedWords, changedWordsInLines, diffSequences, type DiffLine, type FileDiff, type Hunk, type Ranges } from "@room/diff";
import { readBlobs, type Repository } from "@room/git";
import {
  analyzeSource,
  compareDeclarations,
  compareImports,
  compareModules,
  languageForPath,
  type DeclarationChange,
  type Import,
  type ImportChange,
  type LanguageName,
  type LineRange,
  type ModuleChanges,
  type Token,
  type TopLevel,
  type UsedChange,
} from "@room/syntax";

export type AnalyzedLine = DiffLine & {
  /**
   * The line's highlighting, as `[length, kind]` runs over `text` (`kind`
   * indexes the file's `tokenKinds`, -1 for plain text): the text isn't sent
   * a second time. Null when the file's language isn't parsed.
   */
  tokens: Array<[number, number]> | null;
  /** A removed or added line's words that differ from the line it pairs with; null: the whole line. */
  changes: Ranges | null;
};

/** One side of a row of a declaration shown before and after. */
export type SideLine = { line: number; text: string; tokens: Array<[number, number]> | null; changes: Ranges | null };

/**
 * Old and new side by side: the same line on both, or a changed one (one
 * side empty when added or removed). A same line that mentions top-level
 * code that's new, different or affected has those mentions in `uses`: its
 * code didn't change, what it does may have.
 */
export type DeclarationRow = { same: boolean; left: SideLine | null; right: SideLine | null; uses: Array<UsedChange> | null };

export type AnalyzedDeclaration = DeclarationChange & {
  /** Its whole code, old beside new; null when unchanged, or the file's code isn't on the page. */
  rows: Array<DeclarationRow> | null;
};
export type AnalyzedHunk = Omit<Hunk, "lines"> & { lines: Array<AnalyzedLine> };
export type AnalyzedFile = Omit<FileDiff, "hunks"> & {
  /** Empty when `codeOmitted`. */
  hunks: Array<AnalyzedHunk>;
  /** The code isn't on this page: only its header, imports and exports. */
  codeOmitted: boolean;
  /** The highlight kinds the lines' tokens point at ("keyword", "string", ...). */
  tokenKinds: Array<string>;
  /** What happened to the file's imports; null when the language isn't parsed. */
  imports: Array<ImportChange> | null;
  /**
   * What happened to the file's exports, followed through its top-level
   * code; null when the language isn't parsed.
   */
  module: ModuleChanges | null;
  /** Each top-level declaration and statement, what happened to it; null when the language isn't parsed. */
  declarations: Array<AnalyzedDeclaration> | null;
  /** Changed lines outside the declarations shown and the imports, in runs; null when the language isn't parsed. */
  outside: Array<OutsideChange> | null;
};

/**
 * A run of changed lines that no changed declaration and no import accounts
 * for (blank lines added or removed aren't changes), and what they are:
 * - comment: comments that belong to no declaration (a blank line between them and it).
 * - moved: lines of declarations whose code is the same: the line diff shows them moved.
 * - other: anything else, e.g. code between declarations that isn't one.
 */
export type OutsideChange = {
  kind: "comment" | "moved" | "other";
  /** For "moved": the declarations the lines are part of. */
  names: Array<string>;
  /** Where it stands in the new file (the line it starts at, or would): places it among the declarations. */
  at: number;
  before: LineRange | null;
  after: LineRange | null;
  added: number;
  removed: number;
  /** Its lines old beside new, with up to 2 unchanged lines around them; null when the file's code isn't on the page. */
  rows: Array<DeclarationRow> | null;
};

/**
 * Every file of a diff, analyzed: the files we have a grammar for are
 * parsed, unless a version is too large to be worth it (a bundle,
 * generated code); those and the rest show as plain text. Only the files in
 * `showCode` keep their code (and get it highlighted): the others keep their
 * imports and exports, which is what a large diff can afford to send. The
 * files in `skip` aren't read or parsed at all.
 */
export async function analyzeFiles(
  repository: Repository,
  files: Array<FileDiff>,
  options: { showCode: Set<string>; skip: Set<string> },
): Promise<Array<AnalyzedFile>> {
  const parsed = files.map((file) => ({
    file,
    language: file.binary || options.skip.has(file.path) ? null : languageForPath(file.path),
  }));
  const blobs = await readBlobs(
    repository,
    parsed.flatMap(({ file, language }) => (language === null ? [] : [file.oldBlob, file.newBlob])).filter((id) => id !== null),
  );
  return Promise.all(
    parsed.map(({ file, language }) => {
      const withCode = options.showCode.has(file.path);
      const tooLarge = [file.oldBlob, file.newBlob].some((id) => id !== null && (blobs.get(id)?.length ?? 0) > 1_000_000);
      if (language === null || tooLarge) return withoutAnalysis(file, withCode);
      return analyzeFileDiff(file, language, blobs, withCode);
    }),
  );
}

/**
 * Parses both whole versions of the file (never the hunks alone: a hunk can
 * start inside a comment or a template string) and puts each version's
 * tokens on its diff lines: added and context lines from the new file,
 * removed lines from the old.
 */
export async function analyzeFileDiff(file: FileDiff, language: LanguageName, blobs: Map<string, string>, withCode: boolean): Promise<AnalyzedFile> {
  const oldSource = file.oldBlob === null ? "" : (blobs.get(file.oldBlob) ?? null);
  const newSource = file.newBlob === null ? "" : (blobs.get(file.newBlob) ?? null);
  if (oldSource === null || newSource === null) {
    return withoutAnalysis(file, withCode);
  }

  const [before, after] = await Promise.all([
    analyzeBlob(language, file.oldBlob, oldSource, withCode),
    analyzeBlob(language, file.newBlob, newSource, withCode),
  ]);

  const tokenKinds: Array<string> = [];
  const runs = (tokens: Array<Token> | undefined): Array<[number, number]> | null => {
    if (tokens === undefined) return null;
    return tokens.map((token) => {
      if (token.kind === null) return [token.text.length, -1];
      let index = tokenKinds.indexOf(token.kind);
      if (index === -1) index = tokenKinds.push(token.kind) - 1;
      return [token.text.length, index];
    });
  };

  const oldLines = oldSource.split("\n");
  const newLines = newSource.split("\n");
  const changes = compareDeclarations(before.topLevel, after.topLevel, oldLines, newLines);

  // Which changed lines the declarations shown, and the imports, account for.
  const coveredOld = new Set<number>();
  const coveredNew = new Set<number>();
  const cover = (lines: Set<number>, range: { startLine: number; endLine: number } | null) => {
    if (range === null) return;
    for (let line = range.startLine; line <= range.endLine; line++) lines.add(line);
  };
  for (const change of changes) {
    if (change.status === "unchanged") continue;
    cover(coveredOld, change.before);
    cover(coveredNew, change.after);
  }
  for (const unit of before.topLevel.units) if (unit.kind === "import") cover(coveredOld, unit);
  for (const unit of after.topLevel.units) if (unit.kind === "import") cover(coveredNew, unit);
  // A blank line added or removed isn't shown as a change, unless it's inside a string (part of a value).
  const oldLiterals = new Set(before.literalLines);
  const newLiterals = new Set(after.literalLines);
  const blankOld = (line: number) => (oldLines[line - 1] ?? "").trim() === "" && !oldLiterals.has(line);
  const blankNew = (line: number) => (newLines[line - 1] ?? "").trim() === "" && !newLiterals.has(line);
  const isOutside = (line: DiffLine | undefined) =>
    line !== undefined &&
    ((line.kind === "removed" && !coveredOld.has(line.oldLine ?? 0) && !blankOld(line.oldLine ?? 0)) ||
      (line.kind === "added" && !coveredNew.has(line.newLine ?? 0) && !blankNew(line.newLine ?? 0)));
  // Lines that are a change neither way: blank ones, which runs of changed lines go on across.
  const isBlankChange = (line: DiffLine | undefined) =>
    line !== undefined && ((line.kind === "removed" && blankOld(line.oldLine ?? 0)) || (line.kind === "added" && blankNew(line.newLine ?? 0)));

  const side = (lines: Array<string>, tokens: Array<Array<Token>> | null, line: number, changes: Ranges | null): SideLine => ({
    line,
    text: lines[line - 1] ?? "",
    tokens: runs(tokens?.[line - 1]),
    changes,
  });

  /** The declaration's old and new code, lined up: same lines side by side, changed ones paired in order. */
  const rows = (change: DeclarationChange): Array<DeclarationRow> => {
    const oldRange = change.before === null ? [] : range(change.before.startLine, change.before.endLine);
    const newRange = change.after === null ? [] : range(change.after.startLine, change.after.endLine);
    const steps = diffSequences(
      oldRange.map((line) => oldLines[line - 1] ?? ""),
      newRange.map((line) => newLines[line - 1] ?? ""),
    );
    const result: Array<DeclarationRow> = [];
    let index = 0;
    while (index < steps.length) {
      const step = steps[index];
      if (step?.kind === "same") {
        const newLine = newRange[step.b] ?? 0;
        const uses = change.uses.filter((use) => use.line === newLine);
        result.push({
          same: true,
          left: side(oldLines, before.lines, oldRange[step.a] ?? 0, null),
          right: side(newLines, after.lines, newLine, null),
          uses: uses.length === 0 ? null : uses,
        });
        index++;
        continue;
      }
      // Blank lines added or removed are left out (see blankOld).
      const removed: Array<number> = [];
      const added: Array<number> = [];
      while (index < steps.length && steps[index]?.kind !== "same") {
        const current = steps[index];
        const oldLine = current?.kind === "removed" ? (oldRange[current.a] ?? 0) : null;
        const newLine = current?.kind === "added" ? (newRange[current.b] ?? 0) : null;
        if (oldLine !== null && !blankOld(oldLine)) removed.push(oldLine);
        if (newLine !== null && !blankNew(newLine)) added.push(newLine);
        index++;
      }
      for (let pair = 0; pair < Math.max(removed.length, added.length); pair++) {
        const oldLine = removed[pair];
        const newLine = added[pair];
        const words = oldLine !== undefined && newLine !== undefined ? changedWords(oldLines[oldLine - 1] ?? "", newLines[newLine - 1] ?? "") : null;
        result.push({
          same: false,
          left: oldLine === undefined ? null : side(oldLines, before.lines, oldLine, words?.before ?? null),
          right: newLine === undefined ? null : side(newLines, after.lines, newLine, words?.after ?? null),
          uses: null,
        });
      }
    }
    return result;
  };

  /** Removed and added lines lined up: each removed one beside the added one in the same place, their changed words marked. */
  const pairedRows = (removed: Array<number>, added: Array<number>): Array<DeclarationRow> =>
    Array.from({ length: Math.max(removed.length, added.length) }, (_, pair) => {
      const oldLine = removed[pair];
      const newLine = added[pair];
      const words = oldLine !== undefined && newLine !== undefined ? changedWords(oldLines[oldLine - 1] ?? "", newLines[newLine - 1] ?? "") : null;
      return {
        same: false,
        left: oldLine === undefined ? null : side(oldLines, before.lines, oldLine, words?.before ?? null),
        right: newLine === undefined ? null : side(newLines, after.lines, newLine, words?.after ?? null),
        uses: null,
      };
    });

  // The changed lines outside, in runs: each run of them in a hunk, unbroken
  // by another line (an added or removed blank line doesn't break one, and isn't in it).
  const outside: Array<OutsideChange> = [];
  for (const hunk of file.hunks) {
    let index = 0;
    while (index < hunk.lines.length) {
      if (!isOutside(hunk.lines[index])) {
        index++;
        continue;
      }
      const start = index;
      let end = index;
      while (index < hunk.lines.length && (isOutside(hunk.lines[index]) || isBlankChange(hunk.lines[index]))) {
        index++;
        if (isOutside(hunk.lines[index - 1])) end = index;
      }
      index = end;
      const run = hunk.lines.slice(start, end).filter((line) => !isBlankChange(line));
      const removed = run.flatMap((line) => (line.kind === "removed" && line.oldLine !== null ? [line.oldLine] : []));
      const added = run.flatMap((line) => (line.kind === "added" && line.newLine !== null ? [line.newLine] : []));

      // What it is. A comment line starts with //, /* or * (a block comment's middle).
      const texts = run.map((line) => line.text.trim());
      const comment = (text: string) => text.startsWith("//") || text.startsWith("/*") || text.startsWith("*");
      const movedFrom = (line: DiffLine) =>
        changes.find((change) => {
          const range = line.kind === "removed" ? change.before : change.after;
          const number = line.kind === "removed" ? line.oldLine : line.newLine;
          return change.status === "unchanged" && range !== null && number !== null && number >= range.startLine && number <= range.endLine;
        });
      const code = run.filter((line) => line.text.trim() !== "");
      const kind: OutsideChange["kind"] = texts.every((text) => text === "" || comment(text))
        ? "comment"
        : code.every((line) => movedFrom(line) !== undefined)
          ? "moved"
          : "other";
      const names = kind === "moved" ? [...new Set(code.map((line) => movedFrom(line)?.label ?? ""))] : [];

      // Where it stands in the new file: its first added line; only removed lines: right after the line before them.
      const previousNew = hunk.lines
        .slice(0, start)
        .reverse()
        .find((line) => line.newLine !== null)?.newLine;
      const at = added[0] ?? (previousNew === undefined || previousNew === null ? hunk.newStart : previousNew + 1);

      // Up to 2 unchanged lines on each side, to see where it is.
      const contextRow = (line: DiffLine): DeclarationRow => ({
        same: true,
        left: side(oldLines, before.lines, line.oldLine ?? 0, null),
        right: side(newLines, after.lines, line.newLine ?? 0, null),
        uses: null,
      });
      const contextBefore = hunk.lines.slice(Math.max(0, start - 2), start).filter((line) => line.kind === "context");
      const contextAfter = hunk.lines.slice(index, index + 2).filter((line) => line.kind === "context");

      outside.push({
        kind,
        names,
        at,
        before: removed.length === 0 ? null : { startLine: Math.min(...removed), endLine: Math.max(...removed) },
        after: added.length === 0 ? null : { startLine: Math.min(...added), endLine: Math.max(...added) },
        added: added.length,
        removed: removed.length,
        rows: withCode ? [...contextBefore.map(contextRow), ...pairedRows(removed, added), ...contextAfter.map(contextRow)] : null,
      });
    }
  }

  return {
    ...file,
    codeOmitted: !withCode,
    tokenKinds,
    imports: compareImports(before.imports, after.imports),
    module: compareModules(before.topLevel, after.topLevel),
    declarations: changes.map((change) => ({
      ...change,
      rows: withCode && change.status !== "unchanged" ? rows(change) : null,
    })),
    outside,
    hunks: !withCode
      ? []
      : file.hunks.map((hunk) => {
          const words = changedWordsInLines(hunk.lines);
          return {
            ...hunk,
            lines: hunk.lines.map((line, index) => ({
              ...line,
              tokens: line.kind === "removed" ? runs(before.lines?.[(line.oldLine ?? 0) - 1]) : runs(after.lines?.[(line.newLine ?? 0) - 1]),
              changes: words[index] ?? null,
            })),
          };
        }),
  };
}

/** The numbers from `first` to `last`, both included. */
function range(first: number, last: number): Array<number> {
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);
}

export function withoutAnalysis(file: FileDiff, withCode: boolean): AnalyzedFile {
  return {
    ...file,
    codeOmitted: !withCode,
    tokenKinds: [],
    imports: null,
    module: null,
    declarations: null,
    outside: null,
    hunks: !withCode
      ? []
      : file.hunks.map((hunk) => {
          const words = changedWordsInLines(hunk.lines);
          return { ...hunk, lines: hunk.lines.map((line, index) => ({ ...line, tokens: null, changes: words[index] ?? null })) };
        }),
  };
}

/**
 * What we take from one version of a file, kept per blob: a blob's contents
 * never change, so neither does what parsing it gives. The structure
 * (imports, top-level graph) is small and kept for many files; the
 * highlighted lines are large and kept for fewer.
 */
type BlobStructure = { imports: Array<Import>; topLevel: TopLevel; literalLines: Array<number> };
type BlobCode = { lines: Array<Array<Token>> };
const structureCache = new Map<string, BlobStructure>();
const linesCache = new Map<string, BlobCode>();

async function analyzeBlob(
  language: LanguageName,
  blob: string | null,
  source: string,
  withLines: boolean,
): Promise<BlobStructure & { lines: Array<Array<Token>> | null }> {
  // A file that doesn't exist on this side: nothing to parse, nothing to keep.
  if (blob === null) {
    const empty = await analyzeSource(language, "", { highlight: withLines });
    return { imports: empty.imports, topLevel: empty.topLevel, literalLines: [], lines: withLines ? empty.lines : null };
  }

  const key = `${language}:${blob}`;
  const structure = recall(structureCache, key);
  const lines = withLines ? recall(linesCache, key) : null;
  if (structure !== undefined && (!withLines || lines !== undefined)) {
    return { ...structure, lines: lines?.lines ?? null };
  }

  const analysis = await analyzeSource(language, source, { highlight: withLines });
  remember(structureCache, key, { imports: analysis.imports, topLevel: analysis.topLevel, literalLines: analysis.literalLines }, 20_000);
  if (withLines) remember(linesCache, key, { lines: analysis.lines }, 500);
  return { imports: analysis.imports, topLevel: analysis.topLevel, literalLines: analysis.literalLines, lines: withLines ? analysis.lines : null };
}

/** Least recently used goes first: a Map keeps insertion order, so a hit moves to the end. */
function recall<Value>(cache: Map<string, Value>, key: string): Value | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

function remember<Value>(cache: Map<string, Value>, key: string, value: Value, limit: number): void {
  cache.set(key, value);
  if (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}
