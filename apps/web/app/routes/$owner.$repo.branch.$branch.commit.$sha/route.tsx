import { useMemo } from "react";
import { data, useLocation, type ShouldRevalidateFunctionArgs } from "react-router";
import { listCommits, openRepository, resolveCommit } from "@room/git";
import { analyzeCommit, prefetchCommits } from "#/commit-analysis.server.ts";
import { ChangesBody, ChangesView, FileTree, ViewTabs, type ChangeView } from "#/components/changes.tsx";
import { commitPath, fileChangesPath, repositoryLabel, repositoryPath } from "#/paths.ts";
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

  return {
    base: repositoryPath(source),
    branch: params.branch,
    commit: commit,
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
  const { base, branch, commit } = loaderData;
  // Only the address's path and query matter here: jumping to a file (its
  // #hash) must not rebuild these, or the whole page renders again.
  const { pathname, search } = useLocation();

  const entries = useMemo(
    () =>
      commit.files.map((file, index) => ({
        file: file,
        id: `file-${index}`,
        loadHref: withOpenFile({ pathname, search }, file.path, `file-${index}`),
        codeHref: fileChangesPath(base, { commit: commit.sha }, file),
      })),
    [base, commit, pathname, search],
  );

  // Which way to show the changes (?view=), declarations unless asked.
  const asked = new URLSearchParams(search).get("view");
  const view: ChangeView = asked === "lines" || asked === "module" ? asked : "declarations";
  // Changes to types only are hidden unless asked for (?types=show): they don't change what runs.
  const showTypes = new URLSearchParams(search).get("types") === "show";
  const tabs = [
    { view: "declarations" as const, label: "Declarations", href: withView({ pathname, search }, "declarations") },
    { view: "lines" as const, label: "Line diff", href: withView({ pathname, search }, "lines") },
    { view: "module" as const, label: "Imports & exports", href: withView({ pathname, search }, "module") },
  ];

  return (
    <ChangesView key={commit.sha} tree={<FileTree entries={entries} />}>
      <ViewTabs current={view} tabs={tabs} />
      <CommitHeader commit={commit} parentHref={(parent) => commitPath(base, branch, parent)} />
      <ChangesBody entries={entries} view={view} showTypes={showTypes} typesHref={withTypes({ pathname, search }, !showTypes)} />
    </ChangesView>
  );
}

/** This page with type-only changes shown (`?types=show`), or hidden: the default. */
function withTypes(location: { pathname: string; search: string }, show: boolean): string {
  const query = new URLSearchParams(location.search);
  if (show) query.set("types", "show");
  else query.delete("types");
  return query.size === 0 ? location.pathname : `${location.pathname}?${query}`;
}

/** This page in another view: declarations is the default, so it isn't in the address. */
function withView(location: { pathname: string; search: string }, view: ChangeView): string {
  const query = new URLSearchParams(location.search);
  if (view === "declarations") query.delete("view");
  else query.set("view", view);
  return query.size === 0 ? location.pathname : `${location.pathname}?${query}`;
}

/** This page again, with one more file's code on it (`?open=`), scrolled to it. */
function withOpenFile(location: { pathname: string; search: string }, path: string, id: string): string {
  const query = new URLSearchParams(location.search);
  query.append("open", path);
  return `${location.pathname}?${query}#${id}`;
}
