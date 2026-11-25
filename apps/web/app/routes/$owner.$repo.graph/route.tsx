import { data } from "react-router";
import { listChangedPaths, openRepository } from "@room/git";
import { changesGraph } from "#/graph.server.ts";
import { repositoryFromParams } from "#/repository.server.ts";
import type { Route } from "./+types/route.ts";

/**
 * The declarations a change touches and how far that goes, through the
 * whole repository (see graph.server.ts): what the graph tabs and Calls
 * draw. `?head=` and `?base=` (commits or trees; no base: nothing before).
 * No page of its own: a page of changes fetches it on those tabs. Its own
 * request: a first scan of a repository takes a while.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const source = repositoryFromParams(params.owner, params.repo);
  if (source === null) {
    throw data("That isn't a repository.", 404);
  }

  const query = new URL(request.url).searchParams;
  const head = query.get("head");
  const base = query.get("base");
  const sha = /^[0-9a-f]{4,64}$/;
  if (head === null || !sha.test(head) || (base !== null && !sha.test(base))) {
    throw data("Which change?", 400);
  }

  // A failure says so on the graph: thrown, it would replace the whole page with an error.
  let paths: Array<string>;
  const repository = await openRepository(source);
  try {
    paths = await listChangedPaths(repository, base, head);
  } catch (error) {
    return { graph: { status: "failed" as const, message: error instanceof Error ? error.message : String(error) } };
  }
  return { graph: await changesGraph(repository, { head, base, paths }) };
}
