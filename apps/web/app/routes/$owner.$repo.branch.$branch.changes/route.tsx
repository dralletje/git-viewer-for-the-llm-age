import { useMemo } from "react";
import { data, useLocation } from "react-router";
import { checkedOutBranch, getWorkingChanges, openRepository } from "@room/git";
import { analyzeFiles } from "#/analyze-diff.server.ts";
import { ChangesBody, ChangesView, FileTree, ViewTabs, type ChangeView } from "#/components/changes.tsx";
import { buildFileTree, filesInTreeOrder } from "#/file-tree.ts";
import { commitPath, fileChangesPath, repositoryLabel, repositoryPath } from "#/paths.ts";
import { repositoryFromParams } from "#/repository.server.ts";
import { ignoredBy } from "#/rules.server.ts";
import type { Route } from "./+types/route.ts";
import { WorkingChangesHeader } from "./components.tsx";

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: loaderData === undefined ? "Current changes" : `Current changes on ${loaderData.branch}` },
];

/**
 * What changed in the work tree since the last commit: staged, not staged
 * and new files, as the commit of all of them would show. Only for the
 * branch that's checked out in a repository on this machine.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const source = repositoryFromParams(params.owner, params.repo);
  if (source === null) {
    throw data("That isn't a repository.", 404);
  }

  const repository = await openRepository(source);
  const checkedOut = await checkedOutBranch(repository);
  if (checkedOut !== params.branch) {
    throw data(
      source.kind === "github"
        ? "A GitHub repository has no work tree: it has no current changes."
        : `${params.branch} isn't checked out in ${repositoryLabel(source)}: its current changes are on ${checkedOut ?? "no branch"}.`,
      404,
    );
  }

  const changes = await getWorkingChanges(repository);

  // Tests and stories are set aside (see rules.server.ts): listed, not read.
  const ignored = new Map(changes.files.map((file) => [file.path, ignoredBy([file.path, file.oldPath ?? file.path])]));

  // Which files show their code: the ones asked for (?open=path), then, in
  // the order the tree shows them, files that aren't set aside and have at
  // most 400 changed lines, until about 2000 lines are on the page. The rest
  // show their imports and exports, one click from their code.
  const requested = new URL(request.url).searchParams.getAll("open");
  const showCode = new Set<string>();
  let budget = 2000;
  for (const file of filesInTreeOrder(buildFileTree(changes.files, (file) => file.path))) {
    const lines = file.additions + file.deletions;
    if (requested.includes(file.path)) {
      showCode.add(file.path);
    } else if (ignored.get(file.path) === null && !file.binary && lines <= 400 && lines <= budget) {
      showCode.add(file.path);
      budget -= lines;
    }
  }
  const skip = new Set([...ignored].filter(([path, rule]) => rule !== null && !requested.includes(path)).map(([path]) => path));

  const files = await analyzeFiles(repository, changes.files, { showCode, skip });

  return {
    base: repositoryPath(source),
    branch: params.branch,
    changes: { ...changes, files: files.map((file) => ({ ...file, ignoredBy: ignored.get(file.path) ?? null })) },
  };
}

export default function WorkingChangesPage({ loaderData }: Route.ComponentProps) {
  const { base, branch, changes } = loaderData;
  // Only the address's path and query matter here: jumping to a file (its
  // #hash) must not rebuild these, or the whole page renders again.
  const { pathname, search } = useLocation();

  const entries = useMemo(
    () =>
      changes.files.map((file, index) => ({
        file: file,
        id: `file-${index}`,
        loadHref: withOpenFile({ pathname, search }, file.path, `file-${index}`),
        codeHref: fileChangesPath(base, { from: changes.base, to: changes.tree }, file),
      })),
    [base, changes, pathname, search],
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
    <ChangesView key={`working-${changes.tree}`} tree={<FileTree entries={entries} />}>
      <ViewTabs current={view} tabs={tabs} />
      <WorkingChangesHeader
        branch={branch}
        head={changes.head}
        headHref={changes.head === null ? null : commitPath(base, branch, changes.head)}
        fileCount={changes.files.length}
        refreshHref={`${pathname}${search}`}
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
