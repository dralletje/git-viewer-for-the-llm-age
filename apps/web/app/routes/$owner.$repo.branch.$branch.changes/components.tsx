import { Link } from "react-router";

export function WorkingChangesHeader({
  branch,
  head,
  headHref,
  fileCount,
  refreshHref,
}: {
  branch: string;
  head: string | null;
  headHref: string | null;
  fileCount: number;
  refreshHref: string;
}) {
  return (
    <header>
      <h2 className="text-xl font-semibold">
        Current changes on <code className="rounded bg-neutral-100 px-1.5 font-mono text-lg dark:bg-neutral-800">{branch}</code>
      </h2>
      <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-neutral-600 dark:text-neutral-400">
        <li>
          {fileCount} {fileCount === 1 ? "file" : "files"}, not committed yet: staged, not staged and new ones
        </li>
        <li>
          since{" "}
          {head === null || headHref === null ? (
            "the start: there are no commits yet"
          ) : (
            <Link to={headHref} className="font-mono underline">
              {head.slice(0, 7)}
            </Link>
          )}
        </li>
        <li>
          <Link to={refreshHref} className="underline" title="Read the work tree again">
            Refresh
          </Link>
        </li>
      </ul>
      {fileCount === 0 && <p className="mt-4 text-sm text-neutral-500">Nothing has changed since the last commit.</p>}
    </header>
  );
}
