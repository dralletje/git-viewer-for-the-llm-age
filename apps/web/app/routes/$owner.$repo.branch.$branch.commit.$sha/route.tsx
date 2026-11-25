import { data, type ShouldRevalidateFunctionArgs } from "react-router";
import { listCommits, openRepository, resolveCommit } from "@room/git";
import { analyzeCommit, prefetchCommits } from "#/commit-analysis.server.ts";
import { ChangesPage } from "#/components/changes-page.tsx";
import { commitPath, graphPath, reachPath, repositoryLabel, repositoryPath } from "#/paths.ts";
import { changesReach } from "#/reach.server.ts";
import { repositoryFromParams } from "#/repository.server.ts";
import type { Route } from "./+types/route.ts";
import { CommitHeader } from "./components.tsx";

export const meta: Route.MetaFunction = ({ loaderData }) => [{ title: loaderData === undefined ? "Commit" : loaderData.commit.subject }];

export async function loader({ params, request }: Route.LoaderArgs) {
  const source = repositoryFromParams(params.owner, params.repo);
  if (source === null) {
    throw data("That isn't a repository.", 404);
  }
  if (!/^[0-9a-f]{4,64}$/.test(params.sha)) {
    throw data(`"${params.sha}" isn't a commit hash.`, 404);
  }

  const repository = await openRepository(source);
  // A full hash: what the commit list links to, and what prefetching keeps results under.
  const sha = await resolveCommit(repository, params.sha);
  const commit = sha === null ? null : await analyzeCommit(repository, sha, new URL(request.url).searchParams.getAll("open"));
  if (commit === null) {
    throw data(`There is no commit ${params.sha} in ${repositoryLabel(source)}.`, 404);
  }

  // Stepping down the list: the 20 commits after this one get ready meanwhile.
  const following = await listCommits(repository, commit.sha, { limit: 21 });
  prefetchCommits(
    repository,
    following.slice(1).map((next) => next.sha),
  );

  // The reach scan starts now, not waited for: the page fetches it from
  // reachHref once it's shown, and that request picks up this scan.
  const reachBase = commit.parents[0] ?? null;
  void changesReach(repository, { head: commit.sha, base: reachBase, files: commit.files });

  return {
    base: repositoryPath(source),
    branch: params.branch,
    commit: commit,
    reachHref: reachPath(repositoryPath(source), { head: commit.sha, base: reachBase }),
    graphHref: graphPath(repositoryPath(source), { head: commit.sha, base: reachBase }),
  };
}

/** A longer commit list beside it doesn't change the commit: don't run it again. */
export function shouldRevalidate({ currentUrl, nextUrl, currentParams, nextParams, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (
    currentParams.sha === nextParams.sha &&
    currentParams.branch === nextParams.branch &&
    currentUrl.searchParams.getAll("open").join("\n") === nextUrl.searchParams.getAll("open").join("\n")
  ) {
    return false;
  }
  return defaultShouldRevalidate;
}

export default function CommitPage({ loaderData }: Route.ComponentProps) {
  const { base, branch, commit, reachHref, graphHref } = loaderData;
  return (
    <ChangesPage
      pageKey={commit.sha}
      title={commit.subject}
      header={<CommitHeader commit={commit} parentHref={(parent) => commitPath(base, branch, parent)} />}
      files={commit.files}
      repository={base}
      range={{ commit: commit.sha }}
      reachHref={reachHref}
      graphHref={graphHref}
    />
  );
}
