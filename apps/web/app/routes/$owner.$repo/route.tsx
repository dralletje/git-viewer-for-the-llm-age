import { Outlet, data, useParams, type ShouldRevalidateFunctionArgs } from "react-router";
import { GitError, listBranches, openRepository } from "@room/git";
import { repositoryLabel, repositoryPath } from "#/paths.ts";
import { repositoryFromParams } from "#/repository.server.ts";
import type { Route } from "./+types/route.ts";
import { BranchList, RepositoryLayout } from "./components.tsx";

export const meta: Route.MetaFunction = ({ loaderData }) => [{ title: loaderData?.label ?? "Repository" }];

export async function loader({ params }: Route.LoaderArgs) {
  const source = repositoryFromParams(params.owner, params.repo);
  if (source === null) {
    throw data("That isn't a repository.", 404);
  }

  let repository;
  try {
    repository = await openRepository(source);
  } catch (error) {
    if (error instanceof GitError && source.kind === "github") {
      throw data(`Could not clone github.com/${source.owner}/${source.name}: it doesn't exist, or this machine has no access to it.`, 404);
    }
    if (error instanceof GitError && source.kind === "local") {
      throw data(`${source.path} isn't a git repository on this machine. (${error.stderr.trim()})`, 404);
    }
    throw error;
  }

  const branches = await listBranches(repository);
  return {
    source: source,
    base: repositoryPath(source),
    label: repositoryLabel(source),
    branches: branches,
  };
}

/** Opening another commit on the same branch leaves the branch list as it is. */
export function shouldRevalidate({ currentParams, nextParams, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (
    currentParams.owner === nextParams.owner &&
    currentParams.repo === nextParams.repo &&
    currentParams.branch === nextParams.branch
  ) {
    return false;
  }
  return defaultShouldRevalidate;
}

export default function Repository({ loaderData }: Route.ComponentProps) {
  const params = useParams();
  const currentBranch = params.branch ?? null;

  return (
    <RepositoryLayout
      label={loaderData.label}
      githubUrl={loaderData.source.kind === "github" ? `https://github.com/${loaderData.source.owner}/${loaderData.source.name}` : null}
      sidebar={
        <BranchList
          base={loaderData.base}
          branches={loaderData.branches}
          currentBranch={currentBranch}
          headLabel={loaderData.source.kind === "github" ? "default" : "checked out"}
        />
      }
    >
      <Outlet />
    </RepositoryLayout>
  );
}
