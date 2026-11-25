import { data } from "react-router";
import { listChangedPaths, openRepository } from "@room/git";
import { changesReach } from "#/reach.server.ts";
import { repositoryFromParams } from "#/repository.server.ts";
import type { Route } from "./+types/route.ts";

/**
 * What a change does to what the repository's files can reach: `?head=` and
 * `?base=` (commits or trees; no base: nothing before). No page of its own:
 * a page of changes fetches it once it's shown. Its own request, not part of
 * the page's: a first scan of a large repository takes longer than a page's
 * render may stay open.
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

  // A failure says so in the reach panel: thrown, it would replace the whole page with an error.
  let paths: Array<string>;
  const repository = await openRepository(source);
  try {
    // The changed files: whose reach shows beside them.
    paths = await listChangedPaths(repository, base, head);
  } catch (error) {
    return { reach: { status: "failed" as const, message: error instanceof Error ? error.message : String(error) } };
  }
  return { reach: await changesReach(repository, { head, base, files: paths.map((path) => ({ path })) }) };
}
