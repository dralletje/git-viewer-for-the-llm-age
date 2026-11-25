import { Link } from "react-router";
import type { Commit } from "@room/git";
import { ChangesHeader } from "#/components/changes-header.tsx";
import { formatDate } from "#/paths.ts";

export function CommitHeader({ commit, parentHref }: { commit: Commit; parentHref: (parent: string) => string }) {
  return (
    <ChangesHeader
      title={commit.subject}
      description={commit.body}
      details={[
        <>
          Author <span className="text-neutral-900 dark:text-neutral-100">{commit.authorName}</span>
        </>,
        <>Date {formatDate(commit.authorDate)}</>,
        <>
          Commit <span className="font-mono">{commit.sha}</span>
        </>,
        commit.parents.length > 0 && (
          <>
            {commit.parents.length > 1 ? "Parents " : "Parent "}
            <span className="font-mono">
              {commit.parents.map((parent, index) => (
                <span key={parent}>
                  {index > 0 && " "}
                  <Link to={parentHref(parent)} className="underline">
                    {parent.slice(0, 7)}
                  </Link>
                </span>
              ))}
            </span>
          </>
        ),
      ]}
    >
      {commit.parents.length > 1 && <p className="mt-2 text-xs text-neutral-500">A merge: showing what it changed compared to its first parent.</p>}
    </ChangesHeader>
  );
}
