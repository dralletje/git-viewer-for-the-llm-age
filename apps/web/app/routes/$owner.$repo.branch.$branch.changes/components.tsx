import { Link } from "react-router";
import { ChangesHeader, RefName } from "#/components/changes-header.tsx";

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
    <ChangesHeader
      title={
        <>
          Current changes on <RefName>{branch}</RefName>
        </>
      }
      details={[
        <>
          {fileCount} {fileCount === 1 ? "file" : "files"}, not committed yet: staged, not staged and new ones
        </>,
        <>
          since{" "}
          {head === null || headHref === null ? (
            "the start: there are no commits yet"
          ) : (
            <Link to={headHref} className="font-mono underline">
              {head.slice(0, 7)}
            </Link>
          )}
        </>,
        <Link to={refreshHref} className="underline" title="Read the work tree again">
          Refresh
        </Link>,
      ]}
    >
      {fileCount === 0 && <p className="mt-4 text-sm text-neutral-500">Nothing has changed since the last commit.</p>}
    </ChangesHeader>
  );
}
