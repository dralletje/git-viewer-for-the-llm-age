import { data } from "react-router";
import { openRepository, readBlobs } from "@room/git";
import { analyzeSource, languageForPath } from "@room/syntax";
import type { DeclarationRow } from "#/analyze-diff.server.ts";
import { scanRepository } from "#/reach.server.ts";
import { repositoryFromParams } from "#/repository.server.ts";
import type { Route } from "./+types/route.ts";

/**
 * One declaration's code as it is at `head` (a commit or a tree), lines
 * `start` to `end` of `path`, highlighted: what the list of unchanged
 * declarations under the files fetches when one is opened. They're in the
 * graph because they use what changed, but their files didn't change, so
 * the page doesn't have their code. No page of its own.
 *
 * As rows of one side, the same shape as a changed declaration's, so it's
 * drawn the same way.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const source = repositoryFromParams(params.owner, params.repo);
  if (source === null) {
    throw data("That isn't a repository.", 404);
  }

  const query = new URL(request.url).searchParams;
  const head = query.get("head") ?? "";
  const path = query.get("path") ?? "";
  const start = Number(query.get("start"));
  const end = Number(query.get("end"));
  if (!/^[0-9a-f]{4,64}$/.test(head) || path === "" || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw data("Which declaration?", 400);
  }
  const language = languageForPath(path);
  if (language === null) {
    throw data(`${path} isn't code room reads.`, 404);
  }

  // The scan the graph came from has every file's blob (and is kept).
  const repository = await openRepository(source);
  const scan = await scanRepository(repository, head);
  const blob = scan.status === "scanned" ? scan.blobs.get(path) : undefined;
  if (blob === undefined) {
    throw data(`There's no ${path} there.`, 404);
  }
  const text = (await readBlobs(repository, [blob])).get(blob);
  if (text === undefined) {
    throw data(`${path} couldn't be read.`, 404);
  }

  const analysis = await analyzeSource(language, text, { highlight: true });
  const lines = text.split("\n");
  const tokenKinds: Array<string> = [];
  const rows: Array<DeclarationRow> = [];
  for (let line = start; line <= Math.min(end, lines.length); line++) {
    const tokens = analysis.lines[line - 1]?.map((token): [number, number] => {
      if (token.kind === null) return [token.text.length, -1];
      let index = tokenKinds.indexOf(token.kind);
      if (index === -1) index = tokenKinds.push(token.kind) - 1;
      return [token.text.length, index];
    });
    const side = { line, text: lines[line - 1] ?? "", tokens: tokens ?? null, changes: null };
    rows.push({ same: true, left: side, right: side, uses: null });
  }
  return { rows, tokenKinds };
}
