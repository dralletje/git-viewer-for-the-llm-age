import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useFetcher } from "react-router";
import type { Capability } from "#/capabilities.ts";
import type { ReachStep, ReachTarget } from "#/reach.ts";
import type { ChangesReach, MarkedStep, ReachGroup } from "#/reach.server.ts";

/** The changes' reach, for the file headers to show: null while it's being scanned. */
const ReachContext = createContext<ChangesReach | null>(null);

/** The changes' reach (see `ReachProvider`): null while it's being scanned. */
export function useReach(): ChangesReach | null {
  return useContext(ReachContext);
}

/**
 * Fetches the reach from `href` (the reach route) once the page is shown,
 * and provides it. Not streamed with the page: a first scan can take longer
 * than a page's render may stay open, and is cut off. A fetcher, as the
 * files' code is: one request of its own, which takes as long as it takes.
 */
export function ReachProvider({ href, children }: { href: string; children: ReactNode }) {
  const fetcher = useFetcher<{ reach: ChangesReach }>();
  // Which href the fetcher's data is for: another page's is stale.
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    fetcher.load(href);
    setLoaded(href);
    // Only a new href loads again; `fetcher` is a new object every render.
  }, [href]);
  const reach = loaded === href && fetcher.state === "idle" ? (fetcher.data?.reach ?? null) : null;
  return <ReachContext.Provider value={reach}>{children}</ReachContext.Provider>;
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

/** A target's chip text: a point's name, or the capability's. */
function targetLabel(target: ReachTarget): string {
  return target.startsWith("point:") ? target.slice("point:".length) : capabilityLabel[target as Capability];
}

/** A target in a sentence ("Reaches …"): a point's name and what it is, or the capability. */
function targetWord(target: ReachTarget, points: Array<{ name: string; about: string | null }>): string {
  if (!target.startsWith("point:")) return capabilityWord[target as Capability];
  const name = target.slice("point:".length);
  const about = points.find((point) => point.name === name)?.about;
  return about === null || about === undefined ? name : `${name} (${about})`;
}

/** A point is the repository's own, from its .room.toml: drawn apart from the capabilities. */
const pointChip = "rounded border border-fuchsia-300 px-1.5 text-[11px] text-fuchsia-800 dark:border-fuchsia-800 dark:text-fuchsia-300";
const newPointChip =
  "rounded border border-fuchsia-500 bg-fuchsia-50 px-1.5 text-[11px] font-medium text-fuchsia-900 dark:border-fuchsia-600 dark:bg-fuchsia-950 dark:text-fuchsia-200";

function chainText(chain: Array<ReachStep>): string {
  return chain.map((step) => `${step.path}:${step.line} ${step.via}${step.name === null ? "" : ` { ${step.name} }`}`).join("\n→ ");
}

/**
 * What a changed file can reach, beside its name: one chip per point
 * (the repository's own, first) and capability, the new ones marked. A file
 * that reaches nothing says so: it only computes, and is the least risky to
 * skim. Nothing while scanning.
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
          key={entry.target}
          title={`${entry.isNew ? "New in these changes: reaches" : "Reaches"} ${targetWord(entry.target, reach.points)}\n${chainText(entry.chain)}`}
          className={
            entry.target.startsWith("point:")
              ? entry.isNew
                ? newPointChip
                : pointChip
              : entry.isNew
                ? "rounded border border-amber-400 bg-amber-50 px-1.5 text-[11px] font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
                : "rounded border border-neutral-300 px-1.5 text-[11px] text-neutral-600 dark:border-neutral-700 dark:text-neutral-400"
          }
        >
          {entry.isNew && "+"}
          {targetLabel(entry.target)}
        </span>
      ))}
    </span>
  );
}

/**
 * Under the page's header: the files that reach something they didn't
 * before, anywhere in the repository, grouped by what gives it to them.
 */
export function ReachPanel() {
  const reach = useContext(ReachContext);
  if (reach === null) {
    return <p className="text-xs text-neutral-500">Scanning what the repository's files can reach…</p>;
  }
  if (reach.status === "too-large") {
    return <p className="text-xs text-neutral-500">Reach not scanned: {reach.sourceFiles} source files is more than a page can wait for.</p>;
  }
  if (reach.status === "failed") {
    return <p className="text-xs text-red-700 dark:text-red-400">Reach couldn't be scanned: {reach.message}</p>;
  }

  const lost =
    reach.lost.length === 0
      ? null
      : `No longer reaching: ${reach.lost.map((entry) => `${targetLabel(entry.target)} (${entry.count} ${entry.count === 1 ? "file" : "files"})`).join(", ")}.`;
  if (reach.gained.length === 0) {
    return (
      <p className="text-xs text-neutral-500">
        No file reaches anything new ({reach.scanned} source files scanned). {lost}
      </p>
    );
  }
  return (
    <section className="rounded-md border border-amber-300 dark:border-amber-800">
      <div className="border-b border-amber-300 bg-amber-50 px-3 py-1.5 dark:border-amber-800 dark:bg-amber-950">
        <h3 className="text-sm font-medium text-amber-950 dark:text-amber-100">New reach</h3>
        <p className="text-xs text-amber-900 dark:text-amber-200">
          With these changes, these files can use something they couldn't before: one of the repository's points (its .room.toml), or
          something outside the program. Each row is one line of code that touches
          the outside: read it first. When it isn't new, the changes added an import that leads to it: that's the line to read. Open a row to see
          every file it reaches, and how; what the changes added is marked. {reach.scanned} source files scanned.
        </p>
      </div>
      <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
        {reach.gained.map((group) => (
          <ReachGroupRow key={`${group.target}\0${group.origin.path}\0${group.origin.via}`} group={group} />
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
          <span
            className={
              group.target.startsWith("point:")
                ? newPointChip
                : "rounded border border-amber-400 px-1.5 text-[11px] font-medium text-amber-900 dark:border-amber-700 dark:text-amber-200"
            }
          >
            {targetLabel(group.target)}
          </span>
          <code className="text-xs">{group.origin.via}</code>
          <span className="text-xs text-neutral-500">
            in <span className="font-mono">{group.origin.path}:{group.origin.line}</span>
            {group.origin.isNew ? (
              <>, new in these changes</>
            ) : group.newImports.length > 0 ? (
              <>
                , already there; newly reached through{" "}
                {group.newImports.map((step, index) => (
                  <span key={`${step.path}:${step.line}`}>
                    {index > 0 && ", "}
                    <span className="font-mono text-amber-900 dark:text-amber-200">
                      {step.path}:{step.line}
                    </span>{" "}
                    (imports {step.name ?? step.via})
                  </span>
                ))}
              </>
            ) : (
              <>, already there and imported; changed code now uses it</>
            )}
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
            <li className="text-xs text-neutral-500">No other file uses it (yet).</li>
          )}
        </ul>
      </details>
    </li>
  );
}

/**
 * `a.ts:3 parse → b.ts:1 readFile → node:fs`: each file, the line whose
 * import leads on, and the name it imports. What the changes added is marked.
 */
function Chain({ chain }: { chain: Array<MarkedStep> }) {
  const last = chain[chain.length - 1];
  return (
    <span>
      {chain.map((step, index) => (
        <span key={`${step.path}:${step.line}`}>
          <span
            title={step.isNew ? "Added in these changes" : undefined}
            className={step.isNew ? "rounded bg-amber-100 px-0.5 dark:bg-amber-900" : undefined}
          >
            <span className={index === 0 ? "text-neutral-900 dark:text-neutral-100" : "text-neutral-500"}>{step.path}</span>
            <span className="text-neutral-400">:{step.line}</span>
            {step.name !== null && <span className="pl-1 text-neutral-600 dark:text-neutral-300">{step.name}</span>}
          </span>
          <span className="px-1 text-neutral-400">→</span>
        </span>
      ))}
      <span className="text-amber-800 dark:text-amber-300">{last?.via}</span>
    </span>
  );
}
