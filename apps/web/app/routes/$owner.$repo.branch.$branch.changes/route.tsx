import { data, useLocation } from "react-router";
import { checkedOutBranch, getWorkingChanges, openRepository } from "@room/git";
import { analyzeChangedFiles } from "#/changes.server.ts";
import { ChangesPage } from "#/components/changes-page.tsx";
import { commitPath, graphPath, reachPath, repositoryLabel, repositoryPath } from "#/paths.ts";
import { changesReach } from "#/reach.server.ts";
import { repositoryFromParams } from "#/repository.server.ts";
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
  const files = await analyzeChangedFiles(repository, changes.files, new URL(request.url).searchParams.getAll("open"));

  // The work tree as a tree (see getWorkingChanges) against the last commit.
  // The scan starts now, not waited for: the page fetches it from reachHref
  // once it's shown, and that request picks up this scan.
  void changesReach(repository, { head: changes.tree, base: changes.head, files });

  return {
    base: repositoryPath(source),
    branch: params.branch,
    changes: { ...changes, files },
    reachHref: reachPath(repositoryPath(source), { head: changes.tree, base: changes.head }),
    graphHref: graphPath(repositoryPath(source), { head: changes.tree, base: changes.head }),
  };
}

export default function WorkingChangesPage({ loaderData }: Route.ComponentProps) {
  const { base, branch, changes, reachHref, graphHref } = loaderData;
  const { pathname, search } = useLocation();
  return (
    <ChangesPage
      pageKey={`working-${changes.tree}`}
      title={`Current changes on ${branch}`}
      header={
        <WorkingChangesHeader
          branch={branch}
          head={changes.head}
          headHref={changes.head === null ? null : commitPath(base, branch, changes.head)}
          fileCount={changes.files.length}
          refreshHref={`${pathname}${search}`}
        />
      }
      files={changes.files}
      repository={base}
      range={{ from: changes.base, to: changes.tree }}
      reachHref={reachHref}
      graphHref={graphHref}
    />
  );
}
