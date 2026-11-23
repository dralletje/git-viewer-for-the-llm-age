/** One step of turning `a` into `b`: keep an item of both, drop one of `a`, add one of `b`. */
export type DiffStep = { kind: "same"; a: number; b: number } | { kind: "removed"; a: number } | { kind: "added"; b: number };

/**
 * The shortest edit script from `a` to `b` (a longest common subsequence),
 * as steps in order. The common start and end are taken off first; when what
 * is left is too large to compare item by item, it shows as all removed,
 * then all added.
 */
export function diffSequences<Item>(a: Array<Item>, b: Array<Item>): Array<DiffStep> {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const steps: Array<DiffStep> = [];
  for (let index = 0; index < start; index++) steps.push({ kind: "same", a: index, b: index });

  const rows = endA - start;
  const columns = endB - start;
  if (rows * columns > 4_000_000) {
    for (let index = start; index < endA; index++) steps.push({ kind: "removed", a: index });
    for (let index = start; index < endB; index++) steps.push({ kind: "added", b: index });
  } else {
    // lengths[i][j]: the longest common subsequence of a[start+i..] and b[start+j..].
    const width = columns + 1;
    const lengths = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = columns - 1; j >= 0; j--) {
        lengths[i * width + j] =
          a[start + i] === b[start + j]
            ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows || j < columns) {
      if (i < rows && j < columns && a[start + i] === b[start + j]) {
        steps.push({ kind: "same", a: start + i, b: start + j });
        i++;
        j++;
      } else if (j === columns || (i < rows && (lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0))) {
        // A tie removes first: a diff reads removed lines, then what replaced them.
        steps.push({ kind: "removed", a: start + i });
        i++;
      } else {
        steps.push({ kind: "added", b: start + j });
        j++;
      }
    }
  }

  for (let offset = 0; offset < a.length - endA; offset++) steps.push({ kind: "same", a: endA + offset, b: endB + offset });
  return steps;
}

/** Character ranges of a line, `[start, end)`. */
export type Ranges = Array<[number, number]>;

/**
 * The words that differ between a removed line and the line that replaced
 * it, as ranges on each. Null when the lines have too little in common for
 * marking words to help: the whole line changed.
 */
export function changedWords(before: string, after: string): { before: Ranges; after: Ranges } | null {
  const words = (text: string) => text.match(/\w+|\s+|[^\w\s]/g) ?? [];
  const oldWords = words(before);
  const newWords = words(after);
  const steps = diffSequences(oldWords, newWords);

  const oldRanges: Ranges = [];
  const newRanges: Ranges = [];
  const add = (ranges: Ranges, start: number, end: number) => {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && last[1] === start) last[1] = end;
    else ranges.push([start, end]);
  };
  let oldOffset = 0;
  let newOffset = 0;
  let common = 0;
  for (const step of steps) {
    if (step.kind === "same") {
      const length = oldWords[step.a]?.length ?? 0;
      // Whitespace in common says little about the lines being alike.
      if (/\S/.test(oldWords[step.a] ?? "")) common += length;
      oldOffset += length;
      newOffset += newWords[step.b]?.length ?? 0;
    } else if (step.kind === "removed") {
      const length = oldWords[step.a]?.length ?? 0;
      add(oldRanges, oldOffset, oldOffset + length);
      oldOffset += length;
    } else {
      const length = newWords[step.b]?.length ?? 0;
      add(newRanges, newOffset, newOffset + length);
      newOffset += length;
    }
  }

  const longest = Math.max(before.trim().length, after.trim().length);
  if (longest === 0 || common / longest < 0.4) return null;
  return { before: oldRanges, after: newRanges };
}

/**
 * For lines of a diff in order: the changed words of each removed line and
 * the added line it pairs with. A run of removed lines followed by a run of
 * added lines pairs up in order, the first with the first. Lines without a
 * partner, or too different from it, get null.
 */
export function changedWordsInLines(lines: Array<{ kind: "context" | "added" | "removed"; text: string }>): Array<Ranges | null> {
  const result: Array<Ranges | null> = lines.map(() => null);
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.kind !== "removed") {
      index++;
      continue;
    }
    const removedStart = index;
    while (lines[index]?.kind === "removed") index++;
    const addedStart = index;
    while (lines[index]?.kind === "added") index++;
    const pairs = Math.min(addedStart - removedStart, index - addedStart);
    for (let pair = 0; pair < pairs; pair++) {
      const words = changedWords(lines[removedStart + pair]?.text ?? "", lines[addedStart + pair]?.text ?? "");
      if (words === null) continue;
      result[removedStart + pair] = words.before;
      result[addedStart + pair] = words.after;
    }
  }
  return result;
}
