import { useState, type ReactNode } from "react";
import { GraphFrame, GraphNote, Line, Swatch } from "#/components/graphs.tsx";
import type { ViewProps } from "#/components/views/views.tsx";
import type { GraphDeclaration } from "#/graph.server.ts";
import type { GraphFile, ScannedGraph } from "#/graphs.ts";
import { hrefOfDeclaration, structureChanged, structureGraph, structureSummary, type StructureFlag, type StructureUse } from "#/views/structure.ts";

/**
 * Structure only: the shape of the change. What uses what now that didn't
 * before, and what stopped, in words first (by the file that does the
 * using), then drawn as on Ripple, but without the unchanged ripple.
 */
export function StructureView({ data, files, pageTitle }: ViewProps) {
  // Off at first: the kept uses are the unchanged part, and would bury what's new.
  const [kept, setKept] = useState(false);
  const hasKept = data.links.some((link) => link.status === "kept");
  const changed = structureChanged(data);

  const toggle = hasKept && (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
      <input type="checkbox" checked={kept} onChange={(event) => setKept(event.target.checked)} className="accent-neutral-600" />
      show the kept uses between changed declarations too
    </label>
  );

  if (!changed && !kept) {
    return (
      <>
        <GraphNote>The structure didn't change: no use between files (or of a package) was added or removed, and no declaration. Only code inside declarations changed.</GraphNote>
        {toggle !== false && <div className="mt-2">{toggle}</div>}
      </>
    );
  }

  const summary = structureSummary(data, { kept });
  const legend = (
    <>
      <Line className="stroke-green-600">now uses</Line>
      <Line className="stroke-red-500" dashed>
        no longer uses
      </Line>
      {kept && <Line className="stroke-neutral-400">still uses (kept)</Line>}
      <Swatch className="border-green-400 bg-green-50 dark:bg-green-950">new declaration</Swatch>
      <Swatch className="border-red-400 bg-red-50 dark:bg-red-950">removed declaration</Swatch>
      <Swatch className="border-violet-300 bg-violet-50 dark:bg-violet-950">a package or global</Swatch>
      <Swatch className="border-indigo-300 bg-indigo-50 dark:bg-indigo-950">an app or package (its package.json's folder)</Swatch>
      <span>An arrow points from what's used to what uses it; a thick one goes from one app or package into another.</span>
    </>
  );

  return (
    <>
      <section className="mt-2 rounded-md border border-neutral-200 px-4 py-3 text-xs dark:border-neutral-800">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">What the change added or removed between declarations</h3>
          {toggle}
        </div>
        <StructureList data={data} files={files} summary={summary} />
      </section>
      <GraphFrame
        title="Only the uses the change added or removed, and the declarations it added or removed"
        legend={legend}
        graph={structureGraph(data, files, { kept })}
        empty="Nothing to draw."
        barTitle={pageTitle}
      />
    </>
  );
}

/** Long lists are cut: the first files show, the rest open on a click. */
const firstFiles = 8;

function StructureList({ data, files, summary }: { data: ScannedGraph; files: Array<GraphFile>; summary: ReturnType<typeof structureSummary> }) {
  const shown = summary.slice(0, firstFiles);
  const rest = summary.slice(firstFiles);
  const list = (part: typeof summary) => (
    <ul className="space-y-2">
      {part.map((file) => (
        <li key={file.path}>
          <div className="font-mono text-[11px] text-neutral-500">
            {file.path}
            {file.app !== null && <span className="ml-2 rounded bg-indigo-50 px-1 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">{file.app}</span>}
          </div>
          <ul className="mt-0.5 space-y-0.5 pl-3">
            {file.uses.map((use) => (
              <UseLine key={`${use.user}\u0001${use.used}`} data={data} files={files} use={use} />
            ))}
            {file.added.length > 0 && (
              <li>
                <span className="text-green-700 dark:text-green-400">new: </span>
                {file.added.map((id, index) => (
                  <span key={id}>
                    {index > 0 && ", "}
                    <Name data={data} files={files} id={id} withPath={false} />
                  </span>
                ))}
              </li>
            )}
            {file.removed.length > 0 && (
              <li>
                <span className="text-red-700 dark:text-red-400">removed: </span>
                {file.removed.map((id, index) => (
                  <span key={id}>
                    {index > 0 && ", "}
                    <Name data={data} files={files} id={id} withPath={false} />
                  </span>
                ))}
              </li>
            )}
          </ul>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      {list(shown)}
      {rest.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200">{rest.length} more files</summary>
          <div className="mt-2">{list(rest)}</div>
        </details>
      )}
    </>
  );
}

function UseLine({ data, files, use }: { data: ScannedGraph; files: Array<GraphFile>; use: StructureUse }) {
  const verb =
    use.status === "added" ? (
      <span className="text-green-700 dark:text-green-400">now uses</span>
    ) : use.status === "removed" ? (
      <span className="text-red-700 dark:text-red-400">no longer uses</span>
    ) : (
      <span className="text-neutral-500">still uses</span>
    );
  return (
    <li className="flex flex-wrap items-baseline gap-x-1.5">
      <Name data={data} files={files} id={use.user} withPath={false} />
      {verb}
      <Name data={data} files={files} id={use.used} withPath={data.declarations[use.used]?.path !== data.declarations[use.user]?.path} />
      {use.flags.map((flag) => (
        <Flag key={flag.kind} flag={flag} />
      ))}
    </li>
  );
}

/** A declaration's name, linked to its code when it's on the page; a package's in violet; with `withPath`, where it is. */
function Name({ data, files, id, withPath }: { data: ScannedGraph; files: Array<GraphFile>; id: string; withPath: boolean }) {
  const declaration: GraphDeclaration | undefined = data.declarations[id];
  if (declaration === undefined) return <code>{id}</code>;
  if (declaration.status === "outside") {
    return <code className="rounded bg-violet-50 px-1 text-violet-900 dark:bg-violet-950 dark:text-violet-200">{declaration.label}</code>;
  }
  const href = hrefOfDeclaration(files, declaration);
  const name = <code className={declaration.status === "removed" ? "line-through" : undefined}>{declaration.label}</code>;
  return (
    <span>
      {href === null ? name : (
        <a href={href} className="hover:underline">
          {name}
        </a>
      )}
      {withPath && <span className="ml-1 font-mono text-[11px] text-neutral-500">({declaration.path})</span>}
    </span>
  );
}

function Flag({ flag }: { flag: StructureFlag }) {
  const badge = (className: string, title: string, children: ReactNode) => (
    <span title={title} className={`rounded px-1.5 text-[11px] font-medium ${className}`}>
      {children}
    </span>
  );
  // "Before" is what the graph sees: uses that touch a changed file, and the ripple. An unchanged file elsewhere may well use it.
  if (flag.kind === "new-dependency") {
    return badge(
      "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200",
      "No other use from this app or package into that one is on the graph: likely a new dependency between them.",
      <>
        new dependency: {flag.from || "root"} → {flag.to || "root"}
      </>,
    );
  }
  if (flag.kind === "new-package") {
    return badge(
      "bg-violet-100 text-violet-900 dark:bg-violet-900/50 dark:text-violet-200",
      "Nothing else on the graph in this app or package used this package before: likely its first use here.",
      <>
        first use of {flag.package} in {flag.app || "the root"}
      </>,
    );
  }
  if (flag.kind === "now-unused") {
    return badge(
      "bg-red-100 text-red-900 dark:bg-red-900/50 dark:text-red-200",
      "Nothing on the graph uses it anymore: it may be left unused.",
      <>now used by nothing here</>,
    );
  }
  return badge("bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300", "What it used was removed in this change.", <>removed with it</>);
}
