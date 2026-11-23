export type GithubRepository = {
  owner: string;
  name: string;
};

/**
 * Reads what a person pastes to point at a repository: `owner/name`,
 * `https://github.com/owner/name` (also with `.git`, `/tree/main`, ...),
 * or `git@github.com:owner/name.git`. Null when it is none of those.
 */
export function parseGithubRepository(input: string): GithubRepository | null {
  const text = input.trim();

  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(text);
  if (ssh !== null) return validGithubRepository(ssh[1] ?? "", ssh[2] ?? "");

  const web = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)/.exec(text);
  if (web !== null) return validGithubRepository(web[1] ?? "", (web[2] ?? "").replace(/\.git$/, ""));

  const short = /^([^/\s]+)\/([^/\s]+)$/.exec(text);
  if (short !== null) return validGithubRepository(short[1] ?? "", short[2] ?? "");

  return null;
}

export function validGithubRepository(owner: string, name: string): GithubRepository | null {
  // GitHub's own rules for owners are stricter; this is enough to keep the
  // values safe as path segments and in a clone URL.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === "." || name === "..") return null;
  return { owner, name };
}
