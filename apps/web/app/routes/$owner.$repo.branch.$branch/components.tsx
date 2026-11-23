import { memo, type ReactNode } from "react";
import { Form, Link } from "react-router";
import type { Commit } from "@room/git";
import { formatDate } from "#/paths.ts";

/** The commit list left of the selected commit, each scrolling on its own. */
export function BranchLayout({ list, children }: { list: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full shrink-0">
      <div className="w-80 shrink-0 snap-start overflow-y-auto border-r border-neutral-200 dark:border-neutral-800">{list}</div>
      {children}
    </div>
  );
}

type ListedCommit = Commit & {
  href: string;
  selected: boolean;
  /** Part of the comparison being shown. */
  inComparison: boolean;
  /** Other branches whose latest commit this is, each linking to "compare with it". */
  tips: Array<{ name: string; href: string }>;
};

export const CommitList = memo(function CommitList({
  branch,
  compare,
  commits,
  workingChanges,
}: {
  branch: string;
  compare: ReactNode;
  commits: Array<ListedCommit>;
  /** The branch is checked out here: what changed since its last commit. Null otherwise. */
  workingChanges: { fileCount: number; href: string; selected: boolean } | null;
}) {
  return (
    <div>
      <div className="sticky top-0 z-10 border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
        <h2 className="truncate px-4 pt-2 font-mono text-sm font-semibold">{branch}</h2>
        {compare}
      </div>
      {workingChanges !== null && (
        <div
          className={`border-b border-l-2 border-b-neutral-200 dark:border-b-neutral-800 ${
            workingChanges.selected ? "border-l-blue-600 bg-blue-50 dark:bg-blue-950/40" : "border-l-amber-400 bg-amber-50/60 dark:border-l-amber-700 dark:bg-amber-950/30"
          }`}
        >
          <Link
            to={workingChanges.href}
            aria-current={workingChanges.selected ? "page" : undefined}
            className="block px-4 py-2 hover:bg-neutral-50/80 dark:hover:bg-neutral-900/80"
          >
            <div className="text-sm font-medium">Current changes</div>
            <div className="mt-0.5 text-xs text-neutral-500">
              {workingChanges.fileCount === 0
                ? "None: the work tree is as committed"
                : `${workingChanges.fileCount} ${workingChanges.fileCount === 1 ? "file" : "files"}, not committed yet`}
            </div>
          </Link>
        </div>
      )}
      <ol>
        {commits.map((commit) => (
          <li
            key={commit.sha}
            className={`border-l-2 ${
              commit.selected
                ? "border-blue-600 bg-blue-50 dark:bg-blue-950/40"
                : commit.inComparison
                  ? "border-sky-400 bg-sky-50/60 dark:border-sky-700 dark:bg-sky-950/30"
                  : "border-transparent"
            }`}
          >
            <Link to={commit.href} aria-current={commit.selected ? "page" : undefined} className="block px-4 py-2 hover:bg-neutral-50/80 dark:hover:bg-neutral-900/80">
              <div className="line-clamp-2 text-sm font-medium">{commit.subject}</div>
              <div className="mt-0.5 flex gap-2 text-xs text-neutral-500">
                <span className="truncate">{commit.authorName}</span>
                <span className="shrink-0">{formatDate(commit.authorDate)}</span>
                {commit.parents.length > 1 && <span className="shrink-0">merge</span>}
                <code className="ml-auto shrink-0">{commit.sha.slice(0, 7)}</code>
              </div>
            </Link>
            {commit.tips.length > 0 && (
              <div className="flex flex-wrap gap-1 px-4 pb-2">
                {commit.tips.map((tip) => (
                  <Link
                    key={tip.name}
                    to={tip.href}
                    title={`${tip.name} ends here. Show what this branch changed since.`}
                    className="max-w-full truncate rounded border border-violet-300 bg-violet-50 px-1.5 font-mono text-[11px] text-violet-900 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-200"
                  >
                    {tip.name}
                  </Link>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
});

/**
 * "Compare with <branch>": a plain GET form, so it works without
 * JavaScript; with it, choosing a branch submits right away.
 */
export function CompareForm({
  action,
  count,
  view,
  branches,
  selected,
  active,
}: {
  action: string;
  /** How many commits the list shows: kept when the form is sent. */
  count: number;
  /** The tab that's open (?view=): kept when the form is sent. */
  view: string | null;
  branches: Array<string>;
  selected: string | null;
  /** A comparison is showing. */
  active: boolean;
}) {
  if (branches.length === 0) return null;
  return (
    <Form method="get" action={action} className="flex items-center gap-2 px-4 pb-2 pt-1 text-xs">
      <label htmlFor="compare-base" className={active ? "font-medium text-sky-700 dark:text-sky-400" : "text-neutral-500"}>
        Changes since
      </label>
      <select
        id="compare-base"
        name="base"
        defaultValue={selected ?? ""}
        key={selected ?? ""}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
        className="min-w-0 flex-1 truncate rounded border border-neutral-300 bg-transparent px-1 py-0.5 font-mono dark:border-neutral-700"
      >
        {selected === null && (
          <option value="" disabled>
            choose a branch
          </option>
        )}
        {branches.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      {count > 50 && <input type="hidden" name="commits" value={count} />}
      {view !== null && <input type="hidden" name="view" value={view} />}
      <button type="submit" className="rounded border border-neutral-300 px-2 py-0.5 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900">
        {active ? "Show" : "Compare"}
      </button>
    </Form>
  );
}

/**
 * The next 50 commits, below the ones already here: a plain link (the
 * same page, a longer list), so the list stays where it is scrolled to.
 */
export function ShowMore({ href }: { href: string }) {
  return (
    <div className="border-t border-neutral-200 px-4 py-3 text-sm dark:border-neutral-800">
      <Link to={href} preventScrollReset className="underline">
        Show 50 more
      </Link>
    </div>
  );
}

/**
 * The branches whose latest commit is in this branch, however far back:
 * where they are, and a click from what this branch changed since.
 */
export function ContainedBranches({ branches }: { branches: Array<{ name: string; commitsSince: number; href: string; active: boolean }> }) {
  if (branches.length === 0) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-1 px-4 pb-2 text-xs">
      <span className="text-neutral-500">Contains</span>
      {branches.map((branch) => (
        <Link
          key={branch.name}
          to={branch.href}
          title={`${branch.name} ends ${branch.commitsSince} ${branch.commitsSince === 1 ? "commit" : "commits"} back. Show what this branch changed since.`}
          className={`max-w-full truncate rounded border px-1.5 font-mono text-[11px] ${
            branch.active
              ? "border-sky-400 bg-sky-100 text-sky-900 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-200"
              : "border-violet-300 bg-violet-50 text-violet-900 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-200"
          }`}
        >
          {branch.name} <span className="opacity-60">−{branch.commitsSince}</span>
        </Link>
      ))}
    </div>
  );
}
