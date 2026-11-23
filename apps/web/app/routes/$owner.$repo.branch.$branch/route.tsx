import { useMemo } from "react";
import { Outlet, data, useLocation, useParams, useRouteLoaderData, type ShouldRevalidateFunctionArgs } from "react-router";
import { checkedOutBranch, countWorkingChanges, listBranches, listCommits, listContainedBranches, openRepository, resolveCommit } from "@room/git";
import { branchPath, commitPath, comparePath, repositoryLabel, repositoryPath, workingChangesPath } from "#/paths.ts";
import { repositoryFromParams } from "#/repository.server.ts";
import type { loader as compareLoader } from "../$owner.$repo.branch.$branch.compare/route.tsx";
import type { Route } from "./+types/route.ts";
import { BranchLayout, CommitList, CompareForm, ContainedBranches, ShowMore } from "./components.tsx";

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: loaderData === undefined ? "Branch" : `${loaderData.branch} · ${loaderData.label}` },
];

export async function loader({ params, request }: Route.LoaderArgs) {
  const source = repositoryFromParams(params.owner, params.repo);
  if (source === null) {
    throw data("That isn't a repository.", 404);
  }

  const branch = params.branch;
  // How many commits the list shows: 50, and 50 more each time it's asked.
  const count = Math.max(50, Number(new URL(request.url).searchParams.get("commits") ?? "50") || 50);

  const repository = await openRepository(source);
  const sha = await resolveCommit(repository, `refs/heads/${branch}`);
  if (sha === null) {
    throw data(`There is no branch "${branch}".`, 404);
  }

  // One more than shown, to know whether there are more.
  const commits = await listCommits(repository, sha, { limit: count + 1 });
  const branches = await listBranches(repository);
  const contained = (await listContainedBranches(repository, sha)).filter((other) => other.name !== branch);
  // The branch checked out on this machine: how many files changed since its last commit.
  const workingChanges = (await checkedOutBranch(repository)) === branch ? await countWorkingChanges(repository) : null;

  // Other branches whose latest commit is in this list: where they are, on this branch.
  const tips = new Map<string, Array<string>>();
  for (const other of branches) {
    if (other.name === branch) continue;
    tips.set(other.sha, [...(tips.get(other.sha) ?? []), other.name]);
  }

  return {
    base: repositoryPath(source),
    label: repositoryLabel(source),
    branch: branch,
    count: count,
    commits: commits.slice(0, count).map((commit) => ({ ...commit, tips: tips.get(commit.sha) ?? [] })),
    hasMore: commits.length > count,
    workingChanges: workingChanges,
    contained: contained,
    otherBranches: branches.filter((other) => other.name !== branch).map((other) => other.name),
    // What "compare" starts from: main or master, else the default branch
    // (in a local repository: the checked-out one), unless that's this one.
    defaultBase:
      branches.find((other) => other.name === "main" && other.name !== branch)?.name ??
      branches.find((other) => other.name === "master" && other.name !== branch)?.name ??
      branches.find((other) => other.isDefault && other.name !== branch)?.name ??
      null,
  };
}

/**
 * The list only depends on the branch and how many commits it shows:
 * opening a commit or a comparison doesn't run git for it again.
 */
export function shouldRevalidate({ currentUrl, nextUrl, currentParams, nextParams, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  // Opening the current changes, or refreshing them: count them again too.
  if (nextUrl.pathname.endsWith("/changes")) {
    return defaultShouldRevalidate;
  }
  if (currentParams.branch === nextParams.branch && currentUrl.searchParams.get("commits") === nextUrl.searchParams.get("commits")) {
    return false;
  }
  return defaultShouldRevalidate;
}

export default function Branch({ loaderData }: Route.ComponentProps) {
  const params = useParams();
  const location = useLocation();
  const { base, branch, count } = loaderData;
  // Opening a commit keeps the list as long as it is, and the tab (?view=) that's open.
  const view = new URLSearchParams(location.search).get("view");
  const listQuery = new URLSearchParams();
  if (count > 50) listQuery.set("commits", String(count));
  if (view !== null) listQuery.set("view", view);
  const countQuery = listQuery.size === 0 ? "" : `?${listQuery}`;
  const viewQuery = view === null ? "" : `&view=${encodeURIComponent(view)}`;

  // On a comparison: which base, and which commits it covers.
  const comparison = useRouteLoaderData<typeof compareLoader>("routes/$owner.$repo.branch.$branch.compare");

  // Rebuilt only when the list, the selected commit or the comparison
  // changes: not when the address's #hash does (jumping to a file).
  const commits = useMemo(() => {
    const compared = new Set(comparison?.comparison?.commits.map((commit) => commit.sha) ?? []);
    return loaderData.commits.map((commit) => ({
      ...commit,
      href: `${commitPath(base, branch, commit.sha)}${countQuery}`,
      selected: commit.sha === params.sha,
      inComparison: compared.has(commit.sha),
      tips: commit.tips.map((name) => ({ name, href: `${comparePath(base, branch, name, count)}${viewQuery}` })),
    }));
  }, [loaderData.commits, comparison, base, branch, count, countQuery, viewQuery, params.sha]);

  const header = useMemo(
    () => (
      <>
        <CompareForm
          action={`${branchPath(base, branch)}/compare`}
          count={count}
          view={view}
          branches={loaderData.otherBranches}
          selected={comparison?.baseName ?? loaderData.defaultBase}
          active={comparison !== undefined}
        />
        <ContainedBranches
          branches={loaderData.contained.map((other) => ({
            name: other.name,
            commitsSince: other.commitsSince,
            href: `${comparePath(base, branch, other.name, count)}${viewQuery}`,
            active: comparison?.baseName === other.name,
          }))}
        />
      </>
    ),
    [loaderData.otherBranches, loaderData.defaultBase, loaderData.contained, comparison, base, branch, count, view, viewQuery],
  );

  // "Show more": this same page (commit or comparison), with a longer list.
  const more = new URLSearchParams(location.search);
  more.set("commits", String(count + 50));

  return (
    <BranchLayout
      list={
        <>
          <CommitList
            branch={branch}
            compare={header}
            commits={commits}
            workingChanges={
              loaderData.workingChanges === null
                ? null
                : {
                    fileCount: loaderData.workingChanges,
                    href: `${workingChangesPath(base, branch)}${countQuery}`,
                    selected: location.pathname.endsWith("/changes"),
                  }
            }
          />
          {loaderData.hasMore && <ShowMore href={`${location.pathname}?${more}${location.hash}`} />}
        </>
      }
    >
      <Outlet />
    </BranchLayout>
  );
}
