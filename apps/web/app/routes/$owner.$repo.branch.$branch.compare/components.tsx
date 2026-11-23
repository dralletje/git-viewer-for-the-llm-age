import { Link } from "react-router";

export function ComparisonHeader({
  branch,
  baseName,
  mergeBase,
  mergeBaseHref,
  commitCount,
  behind,
  fileCount,
}: {
  branch: string;
  baseName: string;
  mergeBase: string | null;
  mergeBaseHref: string | null;
  commitCount: number;
  behind: number;
  fileCount: number;
}) {
  return (
    <header>
      <h2 className="text-xl font-semibold">
        What <code className="rounded bg-neutral-100 px-1.5 font-mono text-lg dark:bg-neutral-800">{branch}</code> changed since{" "}
        <code className="rounded bg-neutral-100 px-1.5 font-mono text-lg dark:bg-neutral-800">{baseName}</code>
      </h2>
      {mergeBase === null ? (
        <p className="mt-2 text-sm text-neutral-500">These share no history: there is nothing to compare.</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-neutral-600 dark:text-neutral-400">
          <li>
            {commitCount} {commitCount === 1 ? "commit" : "commits"}, {fileCount} {fileCount === 1 ? "file" : "files"}
          </li>
          <li>
            since it left <code className="font-mono">{baseName}</code> at{" "}
            {mergeBaseHref !== null && (
              <Link to={mergeBaseHref} className="font-mono underline">
                {mergeBase.slice(0, 7)}
              </Link>
            )}
          </li>
          {behind > 0 && (
            <li title={`Not part of this comparison: ${baseName} changed these after ${branch} left it.`}>
              <code className="font-mono">{baseName}</code> has {behind} newer {behind === 1 ? "commit" : "commits"} that {branch} doesn't
            </li>
          )}
        </ul>
      )}
      {mergeBase !== null && commitCount === 0 && (
        <p className="mt-4 text-sm text-neutral-500">
          <code className="font-mono">{branch}</code> has nothing that <code className="font-mono">{baseName}</code> doesn't.
        </p>
      )}
    </header>
  );
}
