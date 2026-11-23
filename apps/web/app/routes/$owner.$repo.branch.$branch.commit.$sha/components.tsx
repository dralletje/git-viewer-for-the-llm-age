import { Link } from "react-router";
import type { Commit } from "@room/git";
import { formatDate } from "#/paths.ts";

export function CommitHeader({ commit, parentHref }: { commit: Commit; parentHref: (parent: string) => string }) {
  return (
    <header>
      <h2 className="text-xl font-semibold">{commit.subject}</h2>
      {commit.body !== "" && <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-neutral-600 dark:text-neutral-400">{commit.body}</pre>}
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-500">
        <div>
          <dt className="inline">Author </dt>
          <dd className="inline text-neutral-900 dark:text-neutral-100">{commit.authorName}</dd>
        </div>
        <div>
          <dt className="inline">Date </dt>
          <dd className="inline">{formatDate(commit.authorDate)}</dd>
        </div>
        <div>
          <dt className="inline">Commit </dt>
          <dd className="inline font-mono">{commit.sha}</dd>
        </div>
        {commit.parents.length > 0 && (
          <div>
            <dt className="inline">{commit.parents.length > 1 ? "Parents " : "Parent "}</dt>
            <dd className="inline font-mono">
              {commit.parents.map((parent, index) => (
                <span key={parent}>
                  {index > 0 && " "}
                  <Link to={parentHref(parent)} className="underline">
                    {parent.slice(0, 7)}
                  </Link>
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>
      {commit.parents.length > 1 && <p className="mt-2 text-xs text-neutral-500">A merge: showing what it changed compared to its first parent.</p>}
    </header>
  );
}

