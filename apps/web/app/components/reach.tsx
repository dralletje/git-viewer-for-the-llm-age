import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Capability } from "#/capabilities.ts";
import type { ReachStep } from "#/reach.ts";
import type { CommitReach, ReachGroup } from "#/reach.server.ts";

/**
 * The commit's reach, for the file headers to show: null while it's being
 * scanned, and on pages that don't scan (current changes, comparisons).
 */
const ReachContext = createContext<CommitReach | null>(null);

/**
 * Provides the reach once the loader's promise settles. Not with Suspense:
 * swapping a fallback for the content would remount the files, closing the
 * ones opened while the scan ran.
 */
export function ReachProvider({ reach, children }: { reach: Promise<CommitReach>; children: ReactNode }) {
  const settled = useSettled(reach);
  return <ReachContext.Provider value={settled}>{children}</ReachContext.Provider>;
}

function useSettled(promise: Promise<CommitReach>): CommitReach | null {
  const [state, setState] = useState<{ promise: Promise<CommitReach>; value: CommitReach } | null>(null);
  useEffect(() => {
    let current = true;
    promise.then(
      (value) => current && setState({ promise, value }),
      (error: unknown) => current && setState({ promise, value: { status: "failed", message: String(error) } }),
    );
    return () => {
      current = false;
    };
  }, [promise]);
  // A value for another commit's promise is stale: the page moved on.
  return state?.promise === promise ? state.value : null;
}

const capabilityLabel: Record<Capability, string> = {
  network: "network",
  database: "database",
  filesystem: "file system",
  process: "processes",
  eval: "eval",
  env: "env vars",
};

const capabilityWord: Record<Capability, string> = {
  network: "the network",
  database: "a database",
  filesystem: "the file system",
  process: "child processes",
  eval: "code evaluation",
  env: "env vars",
};

function chainText(chain: Array<ReachStep>): string {
  return chain.map((step) => `${step.path}:${step.line} ${step.via}${step.name === null ? "" : ` { ${step.name} }`}`).join("\n→ ");
}

/**
 * What a changed file can reach, beside its name: one chip per capability,
 * the new ones marked. A file that reaches nothing says so: it only
 * computes, and is the least risky to skim. Nothing while scanning.
 */
export function ReachChips({ path }: { path: string }) {
  const reach = useContext(ReachContext);
  if (reach === null || reach.status !== "scanned") return null;
  const entries = reach.files[path];
  if (entries === undefined) return null;
  if (entries.length === 0) {
    return (
      <span
        title="Reaches no network, database, file system, processes, eval or env vars, itself or through its imports: it only computes."
        className="shrink-0 rounded border border-green-200 px-1.5 text-[11px] text-green-800 dark:border-green-900 dark:text-green-300"
      >
        reaches nothing
      </span>
    );
  }
  return (
    <span className="flex shrink-0 gap-1">
      {entries.map((entry) => (
        <span
          key={entry.capability}
          title={`${entry.isNew ? "New in this commit: reaches" : "Reaches"} ${capabilityWord[entry.capability]}\n${chainText(entry.chain)}`}
          className={
            entry.isNew
              ? "rounded border border-amber-400 bg-amber-50 px-1.5 text-[11px] font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
              : "rounded border border-neutral-300 px-1.5 text-[11px] text-neutral-600 dark:border-neutral-700 dark:text-neutral-400"
          }
        >
          {entry.isNew && "+"}
          {capabilityLabel[entry.capability]}
        </span>
      ))}
    </span>
  );
}

/**
 * Under the commit's header: the files that reach something they didn't
 * before, anywhere in the repository, grouped by what gives it to them.
 */
export function ReachPanel() {
  const reach = useContext(ReachContext);
  if (reach === null) {
    return <p className="mt-4 text-xs text-neutral-500">Scanning what the repository's files can reach…</p>;
  }
  if (reach.status === "too-large") {
    return <p className="mt-4 text-xs text-neutral-500">Reach not scanned: {reach.sourceFiles} source files is more than a page can wait for.</p>;
  }
  if (reach.status === "failed") {
    return <p className="mt-4 text-xs text-red-700 dark:text-red-400">Reach couldn't be scanned: {reach.message}</p>;
  }

  const lost =
    reach.lost.length === 0
      ? null
      : `No longer reaching: ${reach.lost.map((entry) => `${capabilityLabel[entry.capability]} (${entry.count} ${entry.count === 1 ? "file" : "files"})`).join(", ")}.`;
  if (reach.gained.length === 0) {
    return (
      <p className="mt-4 text-xs text-neutral-500">
        No file reaches anything new ({reach.scanned} source files scanned). {lost}
      </p>
    );
  }
  return (
    <section className="mt-4 rounded-md border border-amber-300 dark:border-amber-800">
      <h3 className="border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
        New reach
        <span className="ml-2 text-xs font-normal text-amber-800 dark:text-amber-300">
          files that can now reach outside the program, of {reach.scanned} scanned
        </span>
      </h3>
      <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
        {reach.gained.map((group) => (
          <ReachGroupRow key={`${group.capability}\0${group.origin.path}\0${group.origin.via}`} group={group} />
        ))}
      </ul>
      {lost !== null && <p className="border-t border-neutral-200 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800">{lost}</p>}
    </section>
  );
}

function ReachGroupRow({ group }: { group: ReachGroup }) {
  const others = group.count - 1;
  return (
    <li>
      <details>
        <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-2 px-3 py-1.5">
          <span className="rounded border border-amber-400 px-1.5 text-[11px] font-medium text-amber-900 dark:border-amber-700 dark:text-amber-200">
            {capabilityLabel[group.capability]}
          </span>
          <code className="text-xs">{group.origin.via}</code>
          <span className="text-xs text-neutral-500">
            in <span className="font-mono">{group.origin.path}:{group.origin.line}</span>
            {group.originIsNew ? ", new in this commit" : ", reached through a new import"}
          </span>
          <span className="ml-auto text-xs text-neutral-500">
            {group.count} {group.count === 1 ? "file" : "files"}
          </span>
        </summary>
        <ul className="flex flex-col gap-1 px-3 pb-2 pl-6">
          {group.files.map((file) => (
            <li key={file.path} className="font-mono text-xs">
              <Chain chain={file.chain} />
            </li>
          ))}
          {group.count > group.files.length && (
            <li className="text-xs text-neutral-500">and {group.count - group.files.length} more</li>
          )}
          {others === 0 && group.files[0]?.chain.length === 1 && (
            <li className="text-xs text-neutral-500">No other file imports it (yet).</li>
          )}
        </ul>
      </details>
    </li>
  );
}

/** `a.ts:3 → b.ts:1 → pg`: each file, and the line whose import leads on. */
function Chain({ chain }: { chain: Array<ReachStep> }) {
  const last = chain[chain.length - 1];
  return (
    <span>
      {chain.map((step) => (
        <span key={step.path}>
          <span className={step === chain[0] ? "text-neutral-900 dark:text-neutral-100" : "text-neutral-500"}>{step.path}</span>
          <span className="text-neutral-400">:{step.line}</span>
          {step.name !== null && <span className="pl-1 text-neutral-600 dark:text-neutral-300">{step.name}</span>}
          <span className="px-1 text-neutral-400">→</span>
        </span>
      ))}
      <span className="text-amber-800 dark:text-amber-300">{last?.via}</span>
    </span>
  );
}
