import { data, redirect } from "react-router";
import { openRepository, resolveCommit } from "@room/git";
import { commitPath, repositoryPath } from "#/paths.ts";
import { repositoryFromParams } from "#/repository.server.ts";
import type { Route } from "./+types/route.ts";

/** A branch on its own opens its newest commit, so there is always code to read beside the list. */
export async function loader({ params, request }: Route.LoaderArgs) {
  const source = repositoryFromParams(params.owner, params.repo);
  if (source === null) {
    throw data("That isn't a repository.", 404);
  }

  const repository = await openRepository(source);
  const head = await resolveCommit(repository, `refs/heads/${params.branch}`);
  if (head === null) {
    throw data(`There is no branch "${params.branch}".`, 404);
  }

  throw redirect(`${commitPath(repositoryPath(source), params.branch, head)}${new URL(request.url).search}`);
}
