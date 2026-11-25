import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { Branch } from "@room/git";
import { branchPath, formatDate } from "#/paths.ts";

export function RepositoryLayout({
  label,
  githubUrl,
  sidebar,
  children,
}: {
  label: string;
  githubUrl: string | null;
  sidebar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <Link to="/" className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
          ← Repositories
        </Link>
        <h1 className="truncate font-mono text-sm font-semibold">{label}</h1>
        {githubUrl !== null && (
          <a href={githubUrl} className="ml-auto text-xs text-neutral-500 underline" target="_blank" rel="noreferrer">
            on GitHub
          </a>
        )}
      </header>
      {/*
        Branches | commits | file tree + code, side by side and wider than the
        screen together: the last part is exactly the screen's width. Opening
        a repository starts on the left, at the branches; choosing another
        branch or commit leaves the scroll where it is.
      */}
      <div className="flex min-h-0 flex-1 snap-x snap-proximity overflow-x-auto overflow-y-hidden">
        <nav className="h-full w-60 shrink-0 snap-start overflow-y-auto border-r border-neutral-200 dark:border-neutral-800">{sidebar}</nav>
        <main className="flex h-full shrink-0">{children}</main>
      </div>
    </div>
  );
}

/** Fetches origin; "Fetching…" while it does. */
export function BranchFetchButton({ busy }: { busy: boolean }) {
  return (
    <button
      type="submit"
      disabled={busy}
      title="Fetch origin's branches now"
      className="rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-neutral-600 hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-900"
    >
      {busy ? "Fetching…" : "Fetch"}
    </button>
  );
}

export function BranchList({
  base,
  branches,
  currentBranch,
  headLabel,
  fetch,
  fetchError,
}: {
  base: string;
  branches: Array<Branch>;
  currentBranch: string | null;
  /** The badge on the branch HEAD points at. */
  headLabel: string;
  /** The form that fetches origin. */
  fetch: ReactNode;
  fetchError: string | null;
}) {
  // Narrows the list as it's typed: the branches whose name contains it.
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = needle === "" ? branches : branches.filter((branch) => branch.name.toLowerCase().includes(needle));
  return (
    <div>
      <div className="sticky top-0 bg-white px-4 py-2 dark:bg-neutral-950">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Branches ({needle === "" ? branches.length : `${shown.length} of ${branches.length}`})
          </h2>
          {fetch}
        </div>
        {fetchError !== null && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{fetchError}</p>}
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter branches"
          aria-label="Filter branches by name"
          className="mt-2 w-full rounded border border-neutral-300 bg-transparent px-2 py-1 text-xs placeholder:text-neutral-400 dark:border-neutral-700"
        />
      </div>
      {shown.length === 0 && <p className="px-4 py-2 text-xs text-neutral-500">No branch name contains “{filter.trim()}”.</p>}
      <ul>
        {shown.map((branch, index) => (
          <li key={branch.name}>
            {/* Where origin's branches start: the ones with no local branch. */}
            {branch.remote && shown[index - 1]?.remote !== true && (
              <div className="flex items-center gap-2 px-4 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                <span>on origin</span>
                <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
              </div>
            )}
            <Link
              to={branchPath(base, branch.name)}
              className={`block px-4 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900 ${
                branch.name === currentBranch ? "bg-neutral-100 dark:bg-neutral-900" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-sm">{branch.name}</span>
                {branch.isDefault && (
                  <span className="shrink-0 rounded bg-neutral-200 px-1.5 text-[10px] font-medium uppercase dark:bg-neutral-800">{headLabel}</span>
                )}
                {branch.behind > 0 && (
                  <span
                    title={`Origin has ${branch.behind} ${branch.behind === 1 ? "commit" : "commits"} this branch doesn't: pushed, not pulled (as of the last fetch). The list shows the local branch.`}
                    className="ml-auto shrink-0 rounded border border-sky-300 px-1 text-[10px] text-sky-700 dark:border-sky-800 dark:text-sky-300"
                  >
                    ↓{branch.behind} on origin
                  </span>
                )}
              </div>
              <div className="truncate text-xs text-neutral-500">
                {formatDate(branch.date)} · {branch.subject}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
