import { useMemo, useState } from "react";
import { Line, Swatch } from "#/components/graphs.tsx";
import type { ViewProps } from "#/components/views/views.tsx";
import { layoutGraph, rippleWithoutFileBoxes, type GraphFile, type GraphLayout, type ScannedGraph } from "#/graphs.ts";
import { changeData, perChange, type ChangeReach } from "#/views/per-change.ts";

/**
 * Per change: a small graph for each changed declaration, of what that
 * change alone spreads to, the largest first. Which change is behind most
 * of the ripple, and which ones barely matter, at a glance. Above them: how
 * few changes make up most of it, and a bar per change for its share.
 */
export function PerChangeView({ data, files }: ViewProps) {
  const result = useMemo(() => perChange(data), [data]);
  const hrefOf = useMemo(() => new Map(files.map((file) => [file.path, file.href])), [files]);
  const { changes, total, topFor80, reachedBy } = result;
  if (changes.length === 0) return <p className="mt-2 text-xs text-neutral-500">No code that runs changed.</p>;

  // A card when it spreads to more than one declaration; the rest are a line each, below.
  const large = changes.filter((change) => change.reached.length > 1);
  const small = changes.filter((change) => change.reached.length <= 1);
  const linkOf = (id: string) => codeLink(data, hrefOf, id);
  const truncated = data.ripple.affected > data.ripple.shown;

  return (
    <section className="py-2">
      <header>
        <h3 className="text-sm font-medium">What each change spreads to, on its own, the largest first</h3>
        <p className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
          {total === 0 ? (
            <>None of the {changes.length} changes is used anywhere else.</>
          ) : (
            <>
              <strong>
                {topFor80} of {changes.length}
              </strong>{" "}
              {changes.length === 1 ? "change causes" : "changes cause"} 80% of the ripple: {total} {total === 1 ? "declaration" : "declarations"} reached.
            </>
          )}
          {truncated && <span className="text-neutral-500"> Only the nearest {data.ripple.shown} of {data.ripple.affected} affected declarations are counted.</span>}
        </p>
      </header>

      {total > 0 && (
        <ol className="mt-3 space-y-0.5 text-xs">
          {changes
            .filter((change) => change.reached.length > 0)
            .map((change) => {
              const shared = change.reached.length - change.unique;
              return (
                <li key={change.id} className="grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-2">
                  <a href={`#per-change-${cssId(change.id)}`} className="truncate font-mono hover:underline" title={`${labelOf(data, change.id)} in ${data.declarations[change.id]?.path ?? ""}`}>
                    {labelOf(data, change.id)}
                  </a>
                  {/* Its share of everything reached: solid what only it reaches, light what others reach too. */}
                  <span className="flex h-3 overflow-hidden rounded-sm bg-neutral-100 dark:bg-neutral-900" title={`${change.unique} only through this change, ${shared} through others too`}>
                    <span className="bg-amber-400 dark:bg-amber-600" style={{ width: `${(change.unique / total) * 100}%` }} />
                    <span className="bg-amber-200 dark:bg-amber-900" style={{ width: `${(shared / total) * 100}%` }} />
                  </span>
                  <span className="w-16 text-right tabular-nums text-neutral-500">
                    {change.reached.length} · {Math.round((change.reached.length / total) * 100)}%
                  </span>
                </li>
              );
            })}
        </ol>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-4 rounded-sm bg-amber-400 dark:bg-amber-600" />
          only this change reaches it
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-4 rounded-sm bg-amber-200 dark:bg-amber-900" />
          other changes reach it too
        </span>
        <Swatch className="border-amber-400 bg-amber-50 dark:bg-amber-950">changed</Swatch>
        <Swatch className="border-green-400 bg-green-50 dark:bg-green-950">new</Swatch>
        <Swatch className="border-sky-400 bg-sky-50 dark:bg-sky-950">same code, uses what changed</Swatch>
        <Line className="stroke-green-600">a use that's new</Line>
        <Line className="stroke-red-500" dashed>
          a use that went away
        </Line>
        <span className="inline-flex items-center gap-1">
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold text-white">2</span>
          reached by that many changes
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 2xl:grid-cols-2">
        {large.map((change) => (
          <ChangeCard key={change.id} data={data} change={change} files={files} reachedBy={reachedBy} href={linkOf(change.id)} />
        ))}
      </div>

      {small.length > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
            {small.length} {small.length === 1 ? "change spreads" : "changes spread"} to one declaration or none
          </h4>
          <ul className="mt-1 divide-y divide-neutral-100 rounded-md border border-neutral-200 text-xs dark:divide-neutral-900 dark:border-neutral-800">
            {small.map((change) => {
              const declaration = data.declarations[change.id];
              const [only] = change.reached;
              return (
                <li key={change.id} id={`per-change-${cssId(change.id)}`} className="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5">
                  <StatusWord status={change.status} />
                  <a href={linkOf(change.id) ?? undefined} className="font-mono font-medium hover:underline">
                    {declaration?.label ?? change.id}
                  </a>
                  <span className="truncate text-neutral-500">{declaration?.path}</span>
                  <span className="text-neutral-500">
                    {only === undefined ? (
                      change.links.length > 0 ? (
                        `${change.links.length} ${change.links.length === 1 ? "use" : "uses"} added or removed, nothing uses it`
                      ) : (
                        "nothing uses it"
                      )
                    ) : (
                      <>
                        → <a href={linkOf(only) ?? undefined} className="font-mono hover:underline">{labelOf(data, only)}</a>
                        {(reachedBy.get(only) ?? 0) > 1 && <span className="ml-1 text-rose-600 dark:text-rose-400">(other changes reach it too)</span>}
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

/** One change: its name, file, what it reaches in numbers, and the drawing of it. */
function ChangeCard({ data, change, files, reachedBy, href }: { data: ScannedGraph; change: ChangeReach; files: Array<GraphFile>; reachedBy: Map<string, number>; href: string | null }) {
  const declaration = data.declarations[change.id];
  const overlap = change.reached.length - change.unique;
  const points = change.points.map((key) => data.targets[key]?.label ?? key);
  return (
    <article id={`per-change-${cssId(change.id)}`} className="scroll-mt-4 rounded-md border border-neutral-200 dark:border-neutral-800">
      <header className="border-b border-neutral-100 px-3 py-2 dark:border-neutral-900">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <StatusWord status={change.status} />
          <a href={href ?? undefined} className="font-mono text-sm font-medium hover:underline">
            {declaration?.label ?? change.id}
          </a>
          <span className="min-w-0 truncate text-xs text-neutral-500">{declaration?.path}</span>
        </div>
        <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">
          <strong className="text-neutral-900 dark:text-neutral-100">{change.reached.length}</strong> declarations reached · {change.files.length} {change.files.length === 1 ? "file" : "files"} ·{" "}
          {change.packages.length} {change.packages.length === 1 ? "app or package" : "apps or packages"}
          {points.length > 0 && (
            <>
              {" "}
              · reaches <span className="font-medium text-fuchsia-700 dark:text-fuchsia-300">{points.join(", ")}</span>
            </>
          )}
          {overlap > 0 && (
            <span className="text-rose-600 dark:text-rose-400">
              {" "}
              · {overlap} also reached by other changes
            </span>
          )}
        </p>
      </header>
      <CardDrawing data={data} change={change} files={files} reachedBy={reachedBy} />
    </article>
  );
}

/** How tall a card's drawing is, fitted; "Full size" shows it as large as it's laid out, scrolling. */
const fittedHeight = 260;

/**
 * The change's own graph, laid out (dagre: at once, no waiting on ELK for
 * every card) and fitted into the card. Too small to read when it's large:
 * "Full size" draws it at its own size, to scroll through.
 */
function CardDrawing({ data, change, files, reachedBy }: { data: ScannedGraph; change: ChangeReach; files: Array<GraphFile>; reachedBy: Map<string, number> }) {
  const [full, setFull] = useState(false);
  const layout = useMemo(() => layoutGraph(rippleWithoutFileBoxes(changeData(data, change), files)), [data, change, files]);
  const fits = layout.height <= fittedHeight && layout.width <= 900;
  return (
    <div className="relative">
      {full ? (
        <div className="max-h-[70vh] overflow-auto">
          <Drawing layout={layout} reachedBy={reachedBy} id={change.id} />
        </div>
      ) : (
        <Drawing layout={layout} reachedBy={reachedBy} id={change.id} fitHeight={Math.min(fittedHeight, layout.height)} />
      )}
      {!fits && (
        <button
          type="button"
          onClick={() => setFull(!full)}
          className="absolute bottom-1.5 right-1.5 rounded border border-neutral-300 bg-white/90 px-1.5 py-0.5 text-[11px] text-neutral-700 shadow-sm hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900/90 dark:text-neutral-200 dark:hover:bg-neutral-800"
        >
          {full ? "Fit" : "Full size"}
        </button>
      )}
    </div>
  );
}

function StatusWord({ status }: { status: ChangeReach["status"] }) {
  const style = {
    changed: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
    added: "bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200",
    removed: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
    affected: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  }[status];
  const word = { changed: "changed", added: "new", removed: "removed", affected: "same code" }[status];
  return <span className={`rounded px-1 text-[10px] font-medium uppercase tracking-wide ${style}`}>{word}</span>;
}

const labelOf = (data: ScannedGraph, id: string) => data.declarations[id]?.label ?? id;

/** Where a declaration's code is on the page: its file's link, then its name (as the Ripple graph's nodes link). */
function codeLink(data: ScannedGraph, hrefOf: Map<string, string>, id: string): string | null {
  const declaration = data.declarations[id];
  if (declaration === undefined) return null;
  const fileHref = hrefOf.get(declaration.path);
  return fileHref === undefined ? null : `${fileHref}--${encodeURIComponent(declaration.label)}`;
}

/** An id an element can have: a declaration's id holds "\0" and slashes. */
function cssId(id: string): string {
  return encodeURIComponent(id).replace(/%/g, "_");
}

// ---------------------------------------------------------------------------
// The drawing: copied from GraphDrawing in components/graphs.tsx (not
// exported there), static, fitted to a height, and with a mark on what other
// changes reach too.

const nodeStyle: Record<string, { box: string; text: string }> = {
  changed: { box: "fill-amber-50 stroke-amber-400 dark:fill-amber-950 dark:stroke-amber-700", text: "fill-amber-950 dark:fill-amber-100" },
  added: { box: "fill-green-50 stroke-green-400 dark:fill-green-950 dark:stroke-green-700", text: "fill-green-950 dark:fill-green-100" },
  removed: { box: "fill-red-50 stroke-red-400 dark:fill-red-950 dark:stroke-red-700", text: "fill-red-900 line-through dark:fill-red-200" },
  affected: { box: "fill-sky-50 stroke-sky-400 dark:fill-sky-950 dark:stroke-sky-700", text: "fill-sky-950 dark:fill-sky-100" },
  unchanged: { box: "fill-white stroke-neutral-300 dark:fill-neutral-950 dark:stroke-neutral-700", text: "fill-neutral-700 dark:fill-neutral-300" },
  external: { box: "fill-violet-50 stroke-violet-300 dark:fill-violet-950 dark:stroke-violet-800", text: "fill-violet-900 dark:fill-violet-200" },
  point: { box: "fill-fuchsia-700 stroke-fuchsia-700 dark:fill-fuchsia-300 dark:stroke-fuchsia-300", text: "fill-white font-semibold dark:fill-fuchsia-950" },
};
const fallbackNode = { box: "fill-white stroke-neutral-300 dark:fill-neutral-950 dark:stroke-neutral-700", text: "fill-neutral-700 dark:fill-neutral-300" };
const edgeStyle: Record<string, { line: string; marker: string }> = {
  added: { line: "stroke-green-600", marker: "green" },
  changed: { line: "stroke-amber-500", marker: "amber" },
  affected: { line: "stroke-sky-500", marker: "sky" },
  removed: { line: "stroke-red-500 [stroke-dasharray:5_4]", marker: "red" },
  point: { line: "stroke-fuchsia-600 [stroke-dasharray:2_3] dark:stroke-fuchsia-400", marker: "fuchsia" },
};
const fallbackEdge = { line: "stroke-neutral-400", marker: "neutral" };
const markerColor: Record<string, string> = {
  green: "fill-green-600",
  amber: "fill-amber-500",
  sky: "fill-sky-500",
  red: "fill-red-500",
  neutral: "fill-neutral-400",
  fuchsia: "fill-fuchsia-600 dark:fill-fuchsia-400",
};

/**
 * The graph as SVG. `fitHeight`: scaled down to at most the card's width
 * and that height (never up); without it, as large as laid out. A
 * declaration other changes reach too gets a badge with how many reach it.
 */
function Drawing({ layout, reachedBy, id, fitHeight }: { layout: GraphLayout; reachedBy: Map<string, number>; id: string; fitHeight?: number }) {
  // Arrowheads are found by id: each drawing its own, there are many on the page.
  const prefix = `pc-${cssId(id)}`;
  const size = fitHeight === undefined ? { width: layout.width, height: layout.height } : { width: "100%", height: fitHeight };
  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      {...size}
      style={fitHeight === undefined ? undefined : { maxWidth: layout.width }}
      preserveAspectRatio="xMinYMid meet"
      className="block font-mono text-[12px]"
      role="img"
      aria-label="What this change spreads to"
    >
      <defs>
        {Object.entries(markerColor).map(([name, className]) => (
          <marker key={name} id={`${prefix}-${name}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className={className} />
          </marker>
        ))}
      </defs>
      {layout.groups.map((group) => (
        <g key={group.id}>
          <rect
            x={group.x - group.width / 2}
            y={group.y - group.height / 2}
            width={group.width}
            height={group.height}
            rx="10"
            strokeWidth="1.5"
            className="fill-indigo-50/40 stroke-indigo-300 dark:fill-indigo-950/30 dark:stroke-indigo-800"
          />
          <text x={group.x - group.width / 2 + 12} y={group.y - group.height / 2 + 19} className="fill-indigo-900 font-sans text-[14px] font-semibold dark:fill-indigo-200">
            {group.label}
          </text>
        </g>
      ))}
      {layout.edges.map((edge, index) => {
        const style = edgeStyle[edge.kind] ?? fallbackEdge;
        return (
          <path key={index} d={pathOf(edge.points)} fill="none" strokeWidth={edge.wide === true ? 2.5 : 1.5} markerEnd={`url(#${prefix}-${style.marker})`} className={style.line}>
            <title>{edge.title}</title>
          </path>
        );
      })}
      {layout.nodes.map((node) => {
        const style = nodeStyle[node.kind] ?? fallbackNode;
        const count = reachedBy.get(node.id) ?? 0;
        const left = node.x - node.width / 2;
        const top = node.y - node.height / 2;
        const box = (
          <g>
            <title>{count > 1 ? `${node.title} (reached by ${count} changes)` : node.title}</title>
            <rect x={left} y={top} width={node.width} height={node.height} rx="4" strokeWidth={node.id === id ? 2.5 : 1.25} className={style.box} />
            <text x={node.x} y={node.note === null ? node.y + 4 : node.y - 3} textAnchor="middle" className={style.text}>
              {shorten(node.label)}
            </text>
            {node.note !== null && (
              <text x={node.x} y={node.y + 12} textAnchor="middle" className="fill-neutral-500 font-sans text-[10px]">
                {node.note}
              </text>
            )}
            {count > 1 && (
              <g>
                <circle cx={left + node.width} cy={top} r="8" className="fill-rose-600" />
                <text x={left + node.width} y={top + 3.5} textAnchor="middle" className="fill-white font-sans text-[10px] font-semibold">
                  {count}
                </text>
              </g>
            )}
          </g>
        );
        return node.href === null ? (
          <g key={node.id}>{box}</g>
        ) : (
          <a key={node.id} href={node.href} className="cursor-pointer [&:hover_rect]:stroke-blue-500">
            {box}
          </a>
        );
      })}
    </svg>
  );
}

/** A label that doesn't fit (48 characters, see `layoutGraph`) loses its start: the end of a path says most. */
function shorten(label: string): string {
  return label.length > 48 ? `…${label.slice(-47)}` : label;
}

/** Through the edge's points, rounded at each bend (dagre's points). */
function pathOf(points: Array<{ x: number; y: number }>): string {
  const [first, ...rest] = points;
  if (first === undefined) return "";
  if (rest.length < 2) return `M ${first.x} ${first.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(" ")}`;
  let path = `M ${first.x} ${first.y}`;
  for (let index = 0; index < rest.length - 1; index++) {
    const control = rest[index];
    const next = rest[index + 1];
    if (control === undefined || next === undefined) continue;
    const end = index === rest.length - 2 ? next : { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 };
    path += ` Q ${control.x} ${control.y} ${end.x} ${end.y}`;
  }
  return path;
}
