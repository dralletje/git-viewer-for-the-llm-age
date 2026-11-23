import { data, redirect } from "react-router";
import { listBranches, openRepository } from "@room/git";
import { branchPath, repositoryPath } from "#/paths.ts";
import { repositoryFromParams } from "#/repository.server.ts";
import type { Route } from "./+types/route.ts";

export async function loader({ params }: Route.LoaderArgs) {
  const source = repositoryFromParams(params.owner, params.repo);
  if (source === null) {
    throw data("That isn't a repository.", 404);
  }

  const repository = await openRepository(source);
  const branches = await listBranches(repository);
  const branch = branches.find((branch) => branch.isDefault) ?? branches[0];
  if (branch === undefined) {
    return { empty: true };
  }

  throw redirect(branchPath(repositoryPath(source), branch.name));
}

export default function RepositoryIndex() {
  return <p className="w-screen p-8 text-neutral-500">This repository has no branches yet.</p>;
}
