import { execFile } from "node:child_process";

export class GitError extends Error {
  readonly args: Array<string>;
  readonly stderr: string;

  constructor(args: Array<string>, stderr: string) {
    super(`git ${args.join(" ")} failed: ${stderr.trim()}`);
    this.args = args;
    this.stderr = stderr;
  }
}

/**
 * Runs git with arguments as a list (never through a shell). Fails instead of
 * asking for credentials: there is no terminal to ask in.
 */
export function runGit(args: Array<string>, options: { cwd?: string; env?: Record<string, string> } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
        env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new GitError(args, stderr || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
