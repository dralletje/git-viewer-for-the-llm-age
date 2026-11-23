import { data } from "react-router";
import { getFileDiff, openRepository, readBlobs } from "@room/git";
import { languageForPath } from "@room/syntax";
import { analyzeFileDiff, withoutAnalysis } from "#/analyze-diff.server.ts";
import { repositoryFromParams } from "#/repository.server.ts";
import type { Route } from "./+types/route.ts";

/**
 * One file's changes, analyzed and with its code: what a page that left a
 * file's code out fetches when the file is opened. No page of its own.
 * `?commit=<sha>` for a commit, `?from=<sha>&to=<sha>` for a comparison;
 * `path`, and `old` for a renamed file's old path.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const source = repositoryFromParams(params.owner, params.repo);
  if (source === null) {
    throw data("That isn't a repository.", 404);
  }

  const query = new URL(request.url).searchParams;
  const path = query.get("path") ?? "";
  const oldPath = query.get("old");
  const commit = query.get("commit");
  const from = query.get("from");
  const to = query.get("to");
  const sha = /^[0-9a-f]{4,64}$/;
  if (path === "") {
    throw data("Which file?", 400);
  }

  let range: { commit: string } | { from: string; to: string };
  if (commit !== null && sha.test(commit)) {
    range = { commit };
  } else if (from !== null && to !== null && sha.test(from) && sha.test(to)) {
    range = { from, to };
  } else {
    throw data("Which commit, or which two commits?", 400);
  }

  const repository = await openRepository(source);
  const diff = await getFileDiff(repository, range, { path, oldPath });
  if (diff === null) {
    throw data(`${path} didn't change there.`, 404);
  }

  const language = diff.binary ? null : languageForPath(diff.path);
  if (language === null) {
    return { file: withoutAnalysis(diff, true) };
  }
  const blobs = await readBlobs(repository, [diff.oldBlob, diff.newBlob].filter((id) => id !== null));
  const tooLarge = [...blobs.values()].some((contents) => contents.length > 1_000_000);
  return { file: tooLarge ? withoutAnalysis(diff, true) : await analyzeFileDiff(diff, language, blobs, true) };
}
