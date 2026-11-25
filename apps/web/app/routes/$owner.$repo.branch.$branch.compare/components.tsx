import { Link } from "react-router";
import { ChangesHeader, RefName } from "#/components/changes-header.tsx";

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
    <ChangesHeader
      title={
        <>
          What <RefName>{branch}</RefName> changed since <RefName>{baseName}</RefName>
        </>
      }
      details={
        mergeBase === null
          ? []
          : [
              <>
                {commitCount} {commitCount === 1 ? "commit" : "commits"}, {fileCount} {fileCount === 1 ? "file" : "files"}
              </>,
              <>
                since it left <code className="font-mono">{baseName}</code> at{" "}
                {mergeBaseHref !== null && (
                  <Link to={mergeBaseHref} className="font-mono underline">
                    {mergeBase.slice(0, 7)}
                  </Link>
                )}
              </>,
              behind > 0 && (
                <span title={`Not part of this comparison: ${baseName} changed these after ${branch} left it.`}>
                  <code className="font-mono">{baseName}</code> has {behind} newer {behind === 1 ? "commit" : "commits"} that {branch} doesn't
                </span>
              ),
            ]
      }
    >
      {mergeBase === null && <p className="mt-2 text-sm text-neutral-500">These share no history: there is nothing to compare.</p>}
      {mergeBase !== null && commitCount === 0 && (
        <p className="mt-4 text-sm text-neutral-500">
          <code className="font-mono">{branch}</code> has nothing that <code className="font-mono">{baseName}</code> doesn't.
        </p>
      )}
    </ChangesHeader>
  );
}
