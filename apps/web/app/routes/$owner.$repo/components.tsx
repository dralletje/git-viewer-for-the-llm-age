import type { ReactNode } from "react";
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

export function BranchList({
  base,
  branches,
  currentBranch,
  headLabel,
}: {
  base: string;
  branches: Array<Branch>;
  currentBranch: string | null;
  /** The badge on the branch HEAD points at. */
  headLabel: string;
}) {
  return (
    <div>
      <h2 className="sticky top-0 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:bg-neutral-950">
        Branches ({branches.length})
      </h2>
      <ul>
        {branches.map((branch) => (
          <li key={branch.name}>
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
