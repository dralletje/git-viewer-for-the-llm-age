import type { ReactNode } from "react";
import { GraphNote, Swatch } from "#/components/graphs.tsx";
import type { ViewProps } from "#/components/views/views.tsx";
import type { GraphDeclaration, Target } from "#/graph.server.ts";
import type { ScannedGraph } from "#/graphs.ts";
import { capabilityTrees, pointTrees, type ReachNode, type TargetTree, type TargetTrees } from "#/views/points.ts";

/**
 * Points first: starts from what matters in the repository (its
 * `.room.toml` points: Medplum, the database, ...) and works back to the
 * changes that reach each one, as an indented tree: under the point, what
 * uses it directly, under that what uses those, down to what changed. The
 * capabilities (network, database, ...) get the same below, since most
 * repositories have no points.
 */
export function PointsView({ data, files }: ViewProps) {
  const points = pointTrees(data);
  const capabilities = capabilityTrees(data);
  const hasPoints = points.reached.length + points.notReached.length > 0;
  const hrefOf = new Map(files.map((file) => [file.path, file.href]));
  return (
    <div className="mt-2 space-y-4 rounded-md border border-neutral-200 px-4 py-3 text-sm dark:border-neutral-800">
      <div>
        <h2 className="font-semibold text-neutral-800 dark:text-neutral-100">What the changes reach, from what matters back to the code</h2>
        <p className="mt-1 text-xs text-neutral-500">Each line uses the one above it: under a point, what uses it directly, then what uses those, down to the declarations that changed. Click a declaration to go to its code.</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
          <Swatch className="border-amber-400 bg-amber-50 dark:bg-amber-950">changed</Swatch>
          <Swatch className="border-green-400 bg-green-50 dark:bg-green-950">new</Swatch>
          <Swatch className="border-red-400 bg-red-50 dark:bg-red-950">removed</Swatch>
          <Swatch className="border-sky-400 bg-sky-50 dark:bg-sky-950">same code, uses what changed</Swatch>
          <Swatch className="border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-950">unchanged, on the way</Swatch>
          <Swatch className="border-violet-300 bg-violet-50 dark:border-violet-800 dark:bg-violet-950">a package or global</Swatch>
        </div>
      </div>
      {data.problems.length > 0 && (
        <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">.room.toml: {data.problems.join("; ")}</p>
      )}
      {hasPoints ? (
        <TargetSection title="Points" trees={points} data={data} hrefOf={hrefOf} noneReached="No change reaches any of the repository's points." />
      ) : (
        <GraphNote>
          This repository has no points. Name what matters in a <code className="font-mono">.room.toml</code> at its root (<code className="font-mono">[[points]]</code> with packages, files or declarations) to see
          the changes that reach each one first. Until then, the capabilities below.
        </GraphNote>
      )}
      <TargetSection title="Capabilities" trees={capabilities} data={data} hrefOf={hrefOf} noneReached="No change uses a package or global that gives a capability." />
    </div>
  );
}

function TargetSection({ title, trees, data, hrefOf, noneReached }: { title: string; trees: TargetTrees; data: ScannedGraph; hrefOf: Map<string, string>; noneReached: string }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-neutral-500 uppercase">{title}</h3>
      {trees.reached.length === 0 && <p className="text-xs text-neutral-500">{noneReached}</p>}
      <div className="space-y-2">
        {trees.reached.map((tree) => (
          <TargetBlock key={tree.target.key} tree={tree} data={data} hrefOf={hrefOf} />
        ))}
      </div>
      {trees.notReached.length > 0 && <NotReached targets={trees.notReached} />}
    </section>
  );
}

function TargetBlock({ tree, data, hrefOf }: { tree: TargetTree; data: ScannedGraph; hrefOf: Map<string, string> }) {
  const counts = [tree.changed > 0 ? `${tree.changed} changed` : null, tree.affected > 0 ? `${tree.affected} with the same code that use what changed` : null].filter((part) => part !== null).join(", ");
  return (
    <details open className="group rounded border border-neutral-200 dark:border-neutral-800">
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 select-none hover:bg-neutral-50 dark:hover:bg-neutral-900">
        <Badge target={tree.target} />
        {tree.target.about !== null && <span className="text-neutral-600 dark:text-neutral-400">{tree.target.about}</span>}
        <span className="ml-auto text-xs text-neutral-500">reached by {counts === "" ? "unchanged code only" : counts}</span>
      </summary>
      <ul className="border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
        {tree.roots.map((node, index) => (
          <TreeLine key={`${node.id}-${index}`} node={node} depth={0} data={data} hrefOf={hrefOf} />
        ))}
      </ul>
    </details>
  );
}

function Badge({ target }: { target: Target }) {
  // The same fuchsia as a point on the graphs; a capability quieter.
  const colour =
    target.kind === "point"
      ? "bg-fuchsia-700 text-white dark:bg-fuchsia-300 dark:text-fuchsia-950"
      : "border border-fuchsia-300 bg-fuchsia-50 text-fuchsia-900 dark:border-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-200";
  return <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${colour}`}>{target.label}</span>;
}

/** The points (or capabilities) nothing here reaches, out of the way. */
function NotReached({ targets }: { targets: Array<Target> }) {
  return (
    <details className="mt-2 text-xs text-neutral-500">
      <summary className="cursor-pointer select-none hover:text-neutral-800 dark:hover:text-neutral-200">
        Not reached: {targets.length} ({targets.map((target) => target.label).join(", ")})
      </summary>
      <ul className="mt-1 space-y-1 pl-4">
        {targets.map((target) => (
          <li key={target.key} className="flex items-baseline gap-2">
            <Badge target={target} />
            {target.about !== null && <span>{target.about}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

const statusStyle: Record<GraphDeclaration["status"], { chip: string; word: string }> = {
  changed: { chip: "border-amber-400 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100", word: "changed" },
  added: { chip: "border-green-400 bg-green-50 text-green-950 dark:border-green-700 dark:bg-green-950 dark:text-green-100", word: "new" },
  removed: { chip: "border-red-400 bg-red-50 text-red-900 line-through dark:border-red-700 dark:bg-red-950 dark:text-red-200", word: "removed" },
  affected: { chip: "border-sky-400 bg-sky-50 text-sky-950 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-100", word: "same code" },
  unchanged: { chip: "border-neutral-300 bg-white text-neutral-700 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300", word: "" },
  outside: { chip: "border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200", word: "" },
};

/** How many lines are under a line: a big branch starts closed, so the tree stays readable. */
function sizeOf(node: ReachNode): number {
  return node.children.reduce((sum, child) => sum + 1 + sizeOf(child), 0);
}

function TreeLine({ node, depth, data, hrefOf }: { node: ReachNode; depth: number; data: ScannedGraph; hrefOf: Map<string, string> }) {
  const row = <Row node={node} data={data} hrefOf={hrefOf} />;
  if (node.children.length === 0) return <li className="py-0.5 pl-4">{row}</li>;
  const children = (
    <ul className="ml-[7px] border-l border-neutral-200 pl-2 dark:border-neutral-800">
      {node.children.map((child, index) => (
        <TreeLine key={`${child.id}-${index}`} node={child} depth={depth + 1} data={data} hrefOf={hrefOf} />
      ))}
    </ul>
  );
  return (
    <li className="py-0.5">
      <details open={depth < 1 || sizeOf(node) <= 12} className="group/line">
        <summary className="flex cursor-pointer list-none items-baseline gap-1 select-none [&::-webkit-details-marker]:hidden">
          <span className="inline-block w-3 shrink-0 text-center text-[10px] text-neutral-400 transition-transform group-open/line:rotate-90">▶</span>
          {row}
        </summary>
        {children}
      </details>
    </li>
  );
}

function Row({ node, data, hrefOf }: { node: ReachNode; data: ScannedGraph; hrefOf: Map<string, string> }): ReactNode {
  const declaration = data.declarations[node.id];
  const use =
    node.use === "added" ? (
      <span className="rounded bg-green-100 px-1 text-[10px] text-green-800 dark:bg-green-900 dark:text-green-200">new use</span>
    ) : node.use === "removed" ? (
      <span className="rounded bg-red-100 px-1 text-[10px] text-red-800 dark:bg-red-900 dark:text-red-200">no longer uses it</span>
    ) : null;
  if (declaration === undefined) return <span className="font-mono text-xs text-neutral-500">{node.id}</span>;
  const style = statusStyle[declaration.status];
  if (declaration.status === "outside") {
    // "outside\0<source>\0<name>": a package's name, or "global".
    const source = node.id.split("\0")[1] ?? "";
    return (
      <span className="inline-flex flex-wrap items-baseline gap-x-2">
        <span className={`rounded border px-1.5 font-mono text-xs ${style.chip}`}>{declaration.label}</span>
        <span className="text-xs text-neutral-500">{source === "global" ? "global" : source === declaration.label ? "package" : `from ${source}`}</span>
        {use}
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2">
      <DeclarationLink declaration={declaration} hrefOf={hrefOf} className={`rounded border px-1.5 font-mono text-xs hover:border-blue-500 ${style.chip}`} />
      {style.word !== "" && <span className="text-[10px] text-neutral-500">{style.word}</span>}
      {use}
      <span className="truncate font-mono text-[11px] text-neutral-400 dark:text-neutral-500">{declaration.path}</span>
    </span>
  );
}

/** To the declaration in its file on the page, as the graph's nodes go (the page falls back to the file). */
function DeclarationLink({ declaration, hrefOf, className }: { declaration: GraphDeclaration; hrefOf: Map<string, string>; className: string }) {
  const fileHref = hrefOf.get(declaration.path);
  const title = `${declaration.label} in ${declaration.path}`;
  if (fileHref === undefined) {
    return (
      <span className={className} title={title}>
        {declaration.label}
      </span>
    );
  }
  return (
    <a href={`${fileHref}--${encodeURIComponent(declaration.label)}`} className={className} title={title}>
      {declaration.label}
    </a>
  );
}
