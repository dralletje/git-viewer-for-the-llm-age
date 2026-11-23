import type { ReactNode } from "react";
import { Form, Link } from "react-router";
import type { LocalRepository } from "@room/git";
import { formatDate } from "#/paths.ts";

export function HomePage({ restricted, children }: { restricted: boolean; children: ReactNode }) {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 px-8 py-16">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Behind the Room</h1>
        <p className="mt-2 text-neutral-500">
          {restricted
            ? "This room shows the repositories it was started with: read their branches, commits and changes."
            : "Point it at a GitHub repository, or one on this machine, to read its branches, commits and changes."}
        </p>
      </div>
      {children}
    </main>
  );
}

export function RoomError({ message }: { message: string }) {
  return <p className="text-sm text-red-600">{message}</p>;
}

/** The GitHub repositories a room was started with. */
export function GithubRepositoryList({ repositories }: { repositories: Array<{ label: string; href: string }> }) {
  if (repositories.length === 0) return null;
  return (
    <section>
      <h2 className="text-sm font-medium">On GitHub</h2>
      <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {repositories.map((repository) => (
          <li key={repository.href}>
            <Link to={repository.href} className="block px-4 py-2 font-mono text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-900">
              {repository.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RepositoryForm({ defaultValue, error }: { defaultValue: string; error: string | null }) {
  return (
    <Form method="get" className="flex flex-col gap-2">
      <label htmlFor="repository" className="text-sm font-medium">
        Repository
      </label>
      <div className="flex gap-2">
        <input
          id="repository"
          name="repository"
          defaultValue={defaultValue}
          placeholder="owner/name, a github.com link, or ~/path/to/repo"
          autoFocus
          required
          className="flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono text-sm dark:border-neutral-700"
        />
        <button type="submit" className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900">
          Open
        </button>
      </div>
      {error !== null && <p className="text-sm text-red-600">{error}</p>}
      <p className="text-xs text-neutral-500">
        A GitHub repository is cloned the first time, which can take a moment for a large one. A local one is read where it is.
      </p>
    </Form>
  );
}

/** Local repositories: the ones in `folder`, or (no folder) the ones a room was started with. */
export function LocalRepositoryList({ folder, repositories }: { folder: string | null; repositories: Array<LocalRepository & { href: string }> }) {
  if (folder === null && repositories.length === 0) return null;
  return (
    <section>
      <h2 className="text-sm font-medium">
        On this machine {folder !== null && <span className="font-mono font-normal text-neutral-500">{folder}</span>}
      </h2>
      {repositories.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">No git repositories in this folder.</p>
      ) : (
        <ul className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {repositories.map((repository) => (
            <li key={repository.path}>
              <Link to={repository.href} className="block px-4 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-900">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-sm font-medium">{repository.name}</span>
                  {repository.branch !== null && <span className="truncate font-mono text-xs text-neutral-500">{repository.branch}</span>}
                </div>
                <div className="truncate text-xs text-neutral-500">
                  {repository.lastCommitDate === null ? "No commits yet" : `${formatDate(repository.lastCommitDate)} · ${repository.lastCommitSubject}`}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
