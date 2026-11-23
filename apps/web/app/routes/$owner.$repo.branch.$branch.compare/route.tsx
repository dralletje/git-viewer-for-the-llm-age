import { useMemo } from "react";
import { data, redirect, useLocation, type ShouldRevalidateFunctionArgs } from "react-router";
import { getComparison, listBranches, openRepository, resolveCommit } from "@room/git";
import { analyzeFiles } from "#/analyze-diff.server.ts";
import { prefetchCommits } from "#/commit-analysis.server.ts";
import { ChangesBody, ChangesView, FileTree, ViewTabs, type ChangeView } from "#/components/changes.tsx";
import { buildFileTree, filesInTreeOrder } from "#/file-tree.ts";
import { commitPath, comparePath, fileChangesPath, repositoryPath } from "#/paths.ts";
import { repositoryFromParams } from "#/repository.server.ts";
import { ignoredBy } from "#/rules.server.ts";
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
  const baseIsBranch = (await resolveCommit(repository, `refs/heads/${base}`)) !== null;
  if (!baseIsBranch && !/^[0-9a-f]{4,64}$/.test(base)) {
    throw data(`There is no branch "${base}".`, 404);
  }
  const comparison = await getComparison(repository, baseIsBranch ? `refs/heads/${base}` : base, `refs/heads/${params.branch}`);
  if (comparison === null) {
    throw data(`There is no branch or commit "${base}", or no branch "${params.branch}".`, 404);
  }

  // The comparison's newest 20 commits get ready meanwhile, for opening them one by one.
  prefetchCommits(
    repository,
    comparison.commits.slice(0, 20).map((commit) => commit.sha),
  );

  // Tests and stories are set aside (see rules.server.ts): listed, not read.
  const ignored = new Map(comparison.files.map((file) => [file.path, ignoredBy([file.path, file.oldPath ?? file.path])]));

  // Which files show their code: the ones asked for (?open=path), then, in
  // the order the tree shows them, files that aren't set aside and have at
  // most 400 changed lines, until about 2000 lines are on the page. A larger
  // diff is rarely read line by line (lockfiles, generated code), and a page
  // with all of it doesn't load: the rest show their imports and exports,
  // one click from their code.
  const requested = url.searchParams.getAll("open");
  const showCode = new Set<string>();
  let budget = 2000;
  for (const file of filesInTreeOrder(buildFileTree(comparison.files, (file) => file.path))) {
    const lines = file.additions + file.deletions;
    if (requested.includes(file.path)) {
      showCode.add(file.path);
    } else if (ignored.get(file.path) === null && !file.binary && lines <= 400 && lines <= budget) {
      showCode.add(file.path);
      budget -= lines;
    }
  }
  const skip = new Set([...ignored].filter(([path, rule]) => rule !== null && !requested.includes(path)).map(([path]) => path));

  const files = await analyzeFiles(repository, comparison.files, { showCode, skip });

  return {
    base: repositoryPath(source),
    branch: params.branch,
    baseName: base,
    comparison: { ...comparison, files: files.map((file) => ({ ...file, ignoredBy: ignored.get(file.path) ?? null })) },
  };
}

/** A longer commit list beside it doesn't change the comparison: don't run it again. */
export function shouldRevalidate({ currentUrl, nextUrl, currentParams, nextParams, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
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
  const { base, branch, baseName, comparison } = loaderData;
  // Only the address's path and query matter here: jumping to a file (its
  // #hash) must not rebuild these, or the whole page renders again.
  const { pathname, search } = useLocation();

  const entries = useMemo(
    () =>
      comparison.files.map((file, index) => ({
        file: file,
        id: `file-${index}`,
        loadHref: withOpenFile({ pathname, search }, file.path, `file-${index}`),
        codeHref: fileChangesPath(base, { from: comparison.mergeBase ?? comparison.base, to: comparison.head }, file),
      })),
    [base, comparison, pathname, search],
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
    <ChangesView key={`${comparison.mergeBase}..${comparison.head}`} tree={<FileTree entries={entries} />}>
      <ViewTabs current={view} tabs={tabs} />
      <ComparisonHeader
        branch={branch}
        baseName={baseName}
        mergeBase={comparison.mergeBase}
        mergeBaseHref={comparison.mergeBase === null ? null : commitPath(base, branch, comparison.mergeBase)}
        commitCount={comparison.commits.length}
        behind={comparison.behind}
        fileCount={comparison.files.length}
      />
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
