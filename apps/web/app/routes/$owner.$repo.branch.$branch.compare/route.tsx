import { data, redirect, type ShouldRevalidateFunctionArgs } from "react-router";
import { branchRef, getComparison, listBranches, openRepository } from "@room/git";
import { analyzeChangedFiles } from "#/changes.server.ts";
import { prefetchCommits } from "#/commit-analysis.server.ts";
import { ChangesPage } from "#/components/changes-page.tsx";
import { commitPath, comparePath, graphPath, reachPath, repositoryPath } from "#/paths.ts";
import { changesReach } from "#/reach.server.ts";
import { repositoryFromParams } from "#/repository.server.ts";
import type { Route } from "./+types/route.ts";
import { ComparisonHeader } from "./components.tsx";

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: loaderData === undefined ? "Compare" : `${loaderData.branch} since ${loaderData.baseName}` },
];

export async function loader({ params, request }: Route.LoaderArgs) {
  const source = repositoryFromParams(params.owner, params.repo);
  if (source === null) {
    throw data("That isn't a repository.", 404);
  }

  const url = new URL(request.url);
  const count = Math.max(50, Number(url.searchParams.get("commits") ?? "50") || 50);
  const repository = await openRepository(source);

  // No base asked for: compare with main or master, else the default branch
  // (in a local repository: the checked-out one), unless that's this one.
  const base = url.searchParams.get("base")?.trim() ?? "";
  if (base === "") {
    const branches = await listBranches(repository);
    const fallback =
      branches.find((branch) => branch.name === "main" && branch.name !== params.branch) ??
      branches.find((branch) => branch.name === "master" && branch.name !== params.branch) ??
      branches.find((branch) => branch.isDefault && branch.name !== params.branch);
    if (fallback === undefined) {
      throw data(`Choose a branch or commit to compare ${params.branch} with.`, 404);
    }
    throw redirect(comparePath(repositoryPath(source), params.branch, fallback.name, count));
  }

  // The base is a branch name, or else a commit.
  // Each a local branch, or origin's of that name (see listBranches).
  const baseRef = await branchRef(repository, base);
  if (baseRef === null && !/^[0-9a-f]{4,64}$/.test(base)) {
    throw data(`There is no branch "${base}".`, 404);
  }
  const headRef = await branchRef(repository, params.branch);
  const comparison = headRef === null ? null : await getComparison(repository, baseRef ?? base, headRef);
  if (comparison === null) {
    throw data(`There is no branch or commit "${base}", or no branch "${params.branch}".`, 404);
  }

  // The comparison's newest 20 commits get ready meanwhile, for opening them one by one.
  prefetchCommits(
    repository,
    comparison.commits.slice(0, 20).map((commit) => commit.sha),
  );

  const files = await analyzeChangedFiles(repository, comparison.files, url.searchParams.getAll("open"));
  const from = comparison.mergeBase ?? comparison.base;

  // What the branch changed: its head against where it left the base. The
  // scan starts now, not waited for: the page fetches it from reachHref once
  // it's shown, and that request picks up this scan.
  void changesReach(repository, { head: comparison.head, base: from, files });

  return {
    base: repositoryPath(source),
    branch: params.branch,
    baseName: base,
    comparison: { ...comparison, files },
    reachHref: reachPath(repositoryPath(source), { head: comparison.head, base: from }),
    graphHref: graphPath(repositoryPath(source), { head: comparison.head, base: from }),
  };
}

/**
 * A longer commit list beside it doesn't change the comparison: don't run it
 * again. A fetch can: either branch may have moved.
 */
export function shouldRevalidate({ currentUrl, nextUrl, currentParams, nextParams, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formMethod !== undefined) {
    return defaultShouldRevalidate;
  }
  if (
    currentParams.branch === nextParams.branch &&
    currentUrl.pathname === nextUrl.pathname &&
    currentUrl.searchParams.get("base") === nextUrl.searchParams.get("base") &&
    currentUrl.searchParams.getAll("open").join("\n") === nextUrl.searchParams.getAll("open").join("\n")
  ) {
    return false;
  }
  return defaultShouldRevalidate;
}

export default function Compare({ loaderData }: Route.ComponentProps) {
  const { base, branch, baseName, comparison, reachHref, graphHref } = loaderData;
  return (
    <ChangesPage
      pageKey={`${comparison.mergeBase}..${comparison.head}`}
      title={`${branch} since ${baseName}`}
      header={
        <ComparisonHeader
          branch={branch}
          baseName={baseName}
          mergeBase={comparison.mergeBase}
          mergeBaseHref={comparison.mergeBase === null ? null : commitPath(base, branch, comparison.mergeBase)}
          commitCount={comparison.commits.length}
          behind={comparison.behind}
          fileCount={comparison.files.length}
        />
      }
      files={comparison.files}
      repository={base}
      range={{ from: comparison.mergeBase ?? comparison.base, to: comparison.head }}
      reachHref={reachHref}
      graphHref={graphHref}
    />
  );
}
