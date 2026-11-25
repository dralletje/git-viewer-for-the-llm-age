import { Outlet, data, useFetcher, useParams, type ShouldRevalidateFunctionArgs } from "react-router";
import { GitError, fetchRepository, listBranches, openRepository } from "@room/git";
import { repositoryLabel, repositoryPath } from "#/paths.ts";
import { repositoryFromParams } from "#/repository.server.ts";
import type { Route } from "./+types/route.ts";
import { BranchFetchButton, BranchList, RepositoryLayout } from "./components.tsx";

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

/**
 * "Fetch": origin's branches now, not only when the repository was opened
 * (a GitHub clone, at most every 30 seconds) or never (one on this machine).
 */
export async function action({ params }: Route.ActionArgs) {
  const source = repositoryFromParams(params.owner, params.repo);
  if (source === null) {
    throw data("That isn't a repository.", 404);
  }

  const repository = await openRepository(source);
  try {
    await fetchRepository(repository);
  } catch (error) {
    if (error instanceof GitError) {
      return { fetchError: `Couldn't fetch origin: ${error.stderr.trim() || error.message}` };
    }
    throw error;
  }
  return { fetchError: null };
}

/**
 * Opening another commit on the same branch leaves the branch list as it is.
 * After a fetch it's read again.
 */
export function shouldRevalidate({ currentParams, nextParams, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formMethod !== undefined) {
    return defaultShouldRevalidate;
  }
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
  // A fetcher, not a <Form>: a navigation would go to this layout's own
  // address and leave the commit or comparison that's open.
  const fetcher = useFetcher<typeof action>();
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
          fetch={
            <fetcher.Form method="post">
              <BranchFetchButton busy={fetcher.state !== "idle"} />
            </fetcher.Form>
          }
          fetchError={fetcher.data?.fetchError ?? null}
        />
      }
    >
      <Outlet />
    </RepositoryLayout>
  );
}
