/**
 * Parses git's unified diff output (`git diff`, `git diff-tree -p`, `git show`)
 * into files, hunks and lines. Every later view (rules that hide files,
 * AST-aware views, "safe file" scanners) works on this model, not on text.
 */

export type DiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
  /** Line number in the old file; null for an added line. */
  oldLine: number | null;
  /** Line number in the new file; null for a removed line. */
  newLine: number | null;
  /** Git's "\ No newline at end of file" followed this line. */
  noNewlineAtEnd: boolean;
};

export type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The text after the second `@@`: usually the enclosing function. */
  section: string;
  lines: Array<DiffLine>;
};

export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";

export type FileDiff = {
  status: FileStatus;
  /** Path before the change; null for an added file. */
  oldPath: string | null;
  /** Path after the change; null for a deleted file. */
  newPath: string | null;
  /** newPath, or oldPath when the file was deleted. */
  path: string;
  oldMode: string | null;
  newMode: string | null;
  /**
   * Object ids of the file's contents before and after, from git's `index`
   * line; null when the file didn't exist on that side, or when the contents
   * didn't change (git then writes no `index` line). Full ids with
   * `--full-index`, abbreviated without.
   */
  oldBlob: string | null;
  newBlob: string | null;
  /** Percentage for renames and copies. */
  similarity: number | null;
  binary: boolean;
  hunks: Array<Hunk>;
  additions: number;
  deletions: number;
};

export function parseDiff(text: string): Array<FileDiff> {
  const files: Array<FileDiff> = [];
  const lines = text.split("\n");
  // Output ends with a newline, which leaves one empty string that isn't a line.
  if (lines.at(-1) === "") lines.pop();

  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const paths = parseDiffGitPaths(line.slice("diff --git ".length));
      file = {
        status: "modified",
        oldPath: paths.oldPath,
        newPath: paths.newPath,
        path: paths.newPath,
        oldMode: null,
        newMode: null,
        oldBlob: null,
        newBlob: null,
        similarity: null,
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      files.push(file);
      hunk = null;
      continue;
    }

    if (file === null) continue;

    if (hunk !== null) {
      const first = line[0];
      if (first === " " || line === "") {
        hunk.lines.push({
          kind: "context",
          text: line.slice(1),
          oldLine: oldLine,
          newLine: newLine,
          noNewlineAtEnd: false,
        });
        oldLine += 1;
        newLine += 1;
        continue;
      }
      if (first === "+") {
        hunk.lines.push({
          kind: "added",
          text: line.slice(1),
          oldLine: null,
          newLine: newLine,
          noNewlineAtEnd: false,
        });
        newLine += 1;
        file.additions += 1;
        continue;
      }
      if (first === "-") {
        hunk.lines.push({
          kind: "removed",
          text: line.slice(1),
          oldLine: oldLine,
          newLine: null,
          noNewlineAtEnd: false,
        });
        oldLine += 1;
        file.deletions += 1;
        continue;
      }
      if (first === "\\") {
        const previous = hunk.lines.at(-1);
        if (previous !== undefined) previous.noNewlineAtEnd = true;
        continue;
      }
      // Anything else ends the hunk; fall through to the header checks.
      hunk = null;
    }

    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (header !== null) {
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        section: header[5] ?? "",
        lines: [],
      };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }

    if (line.startsWith("new file mode ")) {
      file.status = "added";
      file.newMode = line.slice("new file mode ".length);
      file.oldPath = null;
    } else if (line.startsWith("deleted file mode ")) {
      file.status = "deleted";
      file.oldMode = line.slice("deleted file mode ".length);
      file.path = file.oldPath ?? file.path;
      file.newPath = null;
    } else if (line.startsWith("old mode ")) {
      file.oldMode = line.slice("old mode ".length);
    } else if (line.startsWith("new mode ")) {
      file.newMode = line.slice("new mode ".length);
    } else if (line.startsWith("similarity index ")) {
      file.similarity = parseInt(line.slice("similarity index ".length), 10);
    } else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = unquotePath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.newPath = unquotePath(line.slice("rename to ".length));
      file.path = file.newPath;
    } else if (line.startsWith("copy from ")) {
      file.status = "copied";
      file.oldPath = unquotePath(line.slice("copy from ".length));
    } else if (line.startsWith("copy to ")) {
      file.status = "copied";
      file.newPath = unquotePath(line.slice("copy to ".length));
      file.path = file.newPath;
    } else if (line.startsWith("index ")) {
      const blobs = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(line);
      if (blobs !== null) {
        // All zeros: the file doesn't exist on that side.
        file.oldBlob = /^0+$/.test(blobs[1] ?? "") ? null : (blobs[1] ?? null);
        file.newBlob = /^0+$/.test(blobs[2] ?? "") ? null : (blobs[2] ?? null);
      }
      const mode = / (\d{6})$/.exec(line);
      if (mode !== null) {
        file.oldMode = file.oldMode ?? mode[1] ?? null;
        file.newMode = file.newMode ?? mode[1] ?? null;
      }
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
    }
    // `--- a/...` and `+++ b/...` repeat what the headers above already said.
  }

  return files;
}

/**
 * The paths on a `diff --git a/x b/y` line. Unquoted paths may contain
 * spaces, so "a/x b/y" can't be split on a space; but when the paths differ
 * git always adds rename/copy lines, which overwrite these. So for an
 * unquoted line both halves are the same path.
 */
function parseDiffGitPaths(rest: string): { oldPath: string; newPath: string } {
  if (rest.startsWith('"') || rest.endsWith('"')) {
    const tokens = rest.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
    const oldPath = stripPrefix(unquotePath(tokens[0] ?? ""));
    const newPath = stripPrefix(unquotePath(tokens[1] ?? ""));
    return { oldPath, newPath };
  }
  const half = rest.slice((rest.length + 1) / 2);
  const path = stripPrefix(half);
  return { oldPath: path, newPath: path };
}

function stripPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

/** Git quotes paths with unusual characters C-style: "tab\there" and octal bytes. */
function unquotePath(path: string): string {
  if (!path.startsWith('"')) return path;
  const inner = path.slice(1, -1);
  const bytes: Array<number> = [];
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index] ?? "";
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }
    const next = inner[index + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(inner.slice(index + 1, index + 4), 8));
      index += 3;
      continue;
    }
    const escapes: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\", a: "\x07", b: "\b", f: "\f", r: "\r", v: "\v" };
    bytes.push(...new TextEncoder().encode(escapes[next] ?? next));
    index += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
