import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { attachCanvas, type Canvas } from "@room/canvas";
import { GraphNote, Line, Swatch } from "#/components/graphs.tsx";
import type { ViewProps } from "#/components/views/views.tsx";
import { layoutGraphElk } from "#/graph-layout-elk.ts";
import type { GraphLayout } from "#/graphs.ts";
import { collapse, expandAll, initialExpanded, zoomGraph, zoomTree, type ZoomTree } from "#/views/zoom.ts";

/**
 * Zoom to summarise: the declaration graph as a node per app or package at
 * first, each opened by a click into its folders, a folder into its files, a
 * file into its declarations. Its own frame rather than GraphFrame: there a
 * click focuses the paths through a node, here it opens it.
 */
export function ZoomView({ data, files, pageTitle }: ViewProps) {
  const tree = useMemo(() => zoomTree(data), [data]);
  const [expanded, setExpanded] = useState<Set<string>>(() => initialExpanded(tree));
  const graph = useMemo(() => zoomGraph(data, tree, expanded, files), [data, tree, expanded, files]);

  // ELK answers with a promise. Until the next layout is there the last one
  // stays drawn: opening a node doesn't blank the graph for a moment.
  const key = JSON.stringify([...expanded].sort());
  const [placed, setPlaced] = useState<{ key: string; layout: GraphLayout | null; error: string | null } | null>(null);
  useEffect(() => {
    if (graph.nodes.length === 0) return;
    let current = true;
    layoutGraphElk(graph).then(
      (layout) => current && setPlaced({ key, layout, error: null }),
      (error: unknown) => current && setPlaced({ key, layout: null, error: String(error) }),
    );
    return () => {
      current = false;
    };
  }, [graph]);

  // Where the clicked node was on screen: the box it opens into (or the node a box closes into) stays there.
  const anchor = useRef<{ id: string; x: number; y: number } | null>(null);
  const toggle = (id: string, at: { x: number; y: number } | null, open: boolean) => {
    anchor.current = at === null ? null : { id, ...at };
    setExpanded((current) => (open ? new Set([...current, id]) : collapse(tree, current, id)));
  };
  const everything = (open: boolean) => {
    anchor.current = null;
    setExpanded(open ? expandAll(tree) : new Set());
  };

  const legend = (
    <>
      <Swatch className="border-amber-400 bg-amber-50 dark:bg-amber-950">has changes</Swatch>
      <Swatch className="border-sky-400 bg-sky-50 dark:bg-sky-950">same code, uses what changed</Swatch>
      <Swatch className="border-green-400 bg-green-50 dark:bg-green-950">new</Swatch>
      <Line className="stroke-amber-500">uses of what changed</Line>
      <Line className="stroke-sky-500">uses of what's affected</Line>
      <Line className="stroke-green-600">uses that are new</Line>
      <Line className="stroke-red-500" dashed>
        uses that went away
      </Line>
      <span>
        The thicker the line, the more uses it carries (the number on it). An arrow points from what's used to what uses it.
        {data.ripple.affected > data.ripple.shown && ` The nearest ${data.ripple.shown} of ${data.ripple.affected} affected declarations.`}
      </span>
    </>
  );

  // The sticky graph's height, as Ripple's (see GraphFrame), kept in the same place.
  const sticky = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(() => {
    try {
      return Number(localStorage.getItem("room:graph-height")) || 0;
    } catch {
      return 0;
    }
  });
  const resizing = useRef<{ startY: number; startHeight: number } | null>(null);
  // The files' headers stick right below it, and a jump puts a file there.
  useEffect(() => {
    const element = sticky.current;
    const column = element?.parentElement;
    if (element === null || element === undefined || column === null || column === undefined) return;
    const update = () => column.style.setProperty("--files-top", `${element.offsetHeight - 24}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      column.style.removeProperty("--files-top");
    };
  }, []);

  const layout = placed?.layout ?? null;
  const drawing =
    graph.nodes.length === 0 ? (
      <p className="px-4 py-3 text-xs text-neutral-500">No code that runs changed.</p>
    ) : placed?.error != null ? (
      <p className="px-4 py-3 text-xs text-red-600 dark:text-red-400">ELK couldn't place this graph: {placed.error}</p>
    ) : layout === null ? (
      <p className="px-4 py-3 text-xs text-neutral-500">Placing {graph.nodes.length} nodes…</p>
    ) : (
      <ZoomCanvas layout={layout} tree={tree} counts={new Map(graph.edges.map((edge) => [`${edge.from}\u0001${edge.to}\u0001${edge.kind}`, edge.count]))} anchor={anchor} onToggle={toggle} />
    );

  const button =
    "rounded border border-neutral-200 px-1.5 py-0.5 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900 disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <>
      <header className="py-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">What the changes spread to, by app or package: click one to open it</h3>
          <span className="text-[11px] text-neutral-500">Click a package, folder or file to open it, an open box's name to close it. A declaration: its code below.</span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-neutral-500">
            <button type="button" onClick={() => everything(true)} className={button}>
              Expand all
            </button>
            <button type="button" onClick={() => everything(false)} disabled={expanded.size === 0} className={button}>
              Collapse all
            </button>
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">{legend}</div>
      </header>
      <div
        ref={sticky}
        data-sticky-graph
        style={{ height: height > 0 ? `${height}px` : "45vh" }}
        className="sticky -top-6 z-20 -mx-6 flex flex-col border-y border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
      >
        {/* Once the header has scrolled away: what these changes are, the buttons, and the way back up. */}
        <div className="flex h-6 shrink-0 items-center gap-2 border-b border-neutral-100 px-3 text-[11px] text-neutral-500 dark:border-neutral-900">
          <span className="min-w-0 flex-1 truncate">{pageTitle}</span>
          <button type="button" onClick={() => everything(true)} className="shrink-0 rounded px-1.5 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200">
            Expand all
          </button>
          <button type="button" onClick={() => everything(false)} className="shrink-0 rounded px-1.5 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200">
            Collapse all
          </button>
          <button
            type="button"
            onClick={() => sticky.current?.parentElement?.scrollTo({ top: 0, behavior: "smooth" })}
            title="Back to the top: the commit, the tabs and the legend"
            className="shrink-0 rounded px-1.5 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            ↑ Top
          </button>
        </div>
        <div className="relative min-h-0 flex-1">{drawing}</div>
        <div
          role="separator"
          aria-orientation="horizontal"
          title="Drag to make the graph taller or shorter"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            resizing.current = { startY: event.clientY, startHeight: sticky.current?.offsetHeight ?? 0 };
          }}
          onPointerMove={(event) => {
            const start = resizing.current;
            if (start === null) return;
            setHeight(Math.round(Math.min(window.innerHeight - 160, Math.max(120, start.startHeight + event.clientY - start.startY))));
          }}
          onPointerUp={() => {
            resizing.current = null;
            try {
              localStorage.setItem("room:graph-height", String(sticky.current?.offsetHeight ?? 0));
            } catch {
              // Not kept: the next page starts at 45% again.
            }
          }}
          className="group/resize absolute inset-x-0 -bottom-2 z-10 flex h-4 cursor-row-resize touch-none items-center justify-center"
        >
          <span className="h-1 w-12 rounded-full bg-neutral-300 group-hover/resize:bg-blue-500 dark:bg-neutral-700" />
        </div>
      </div>
    </>
  );
}

type Anchor = { id: string; x: number; y: number };

/**
 * The drawing on a pan/zoom canvas. Fitted at first and after Expand or
 * Collapse all; after opening or closing one thing the view stays put, with
 * what was clicked where it was. The declaration being read below is marked,
 * as in Ripple, when it's open on the graph.
 */
function ZoomCanvas({
  layout,
  tree,
  counts,
  anchor,
  onToggle,
}: {
  layout: GraphLayout;
  tree: ZoomTree;
  counts: Map<string, number>;
  anchor: { current: Anchor | null };
  onToggle: (id: string, at: { x: number; y: number } | null, open: boolean) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const canvas = useRef<Canvas | null>(null);

  // Before the browser paints: no frame of the new drawing at the old view.
  useLayoutEffect(() => {
    const frame = viewport.current;
    const drawing = content.current;
    if (frame === null || drawing === null) return;
    const before = canvas.current?.view() ?? null;
    canvas.current?.destroy();
    const attached = attachCanvas(frame, drawing, { size: { width: layout.width, height: layout.height }, minScale: 0.05, maxScale: 3 });
    canvas.current = attached;
    const at = anchor.current;
    anchor.current = null;
    const now = at === null || before === null ? undefined : (layout.groups.find((group) => group.id === at.id) ?? layout.nodes.find((node) => node.id === at.id));
    if (at === null || before === null || now === undefined) {
      attached.fit({ maxScale: 1 });
      return;
    }
    // What was clicked keeps its top left corner on screen; then as much of what it opened into as fits comes into sight.
    const left = now.x - now.width / 2;
    const top = now.y - now.height / 2;
    attached.setView({ x: at.x - left * before.scale, y: at.y - top * before.scale, scale: before.scale });
    attached.show({ x: left, y: top - 20, width: now.width, height: now.height + 20 }, { animate: true, margin: 24 });
  }, [layout]);
  useEffect(
    () => () => {
      canvas.current?.destroy();
      canvas.current = null;
    },
    [],
  );

  /** Where a rect of the drawing is on screen now, relative to the viewport: what a click keeps in place. */
  const onScreen = (x: number, y: number) => {
    const view = canvas.current?.view();
    return view === undefined ? null : { x: view.x + x * view.scale, y: view.y + y * view.scale };
  };

  // The declaration being read in the code: its node marked and in sight, when it's open.
  useEffect(() => {
    const onReading = (event: Event) => {
      const id = (event as CustomEvent<{ id: string | null }>).detail.id;
      const svg = content.current;
      if (svg === null) return;
      svg.querySelectorAll("[data-current]").forEach((element) => element.removeAttribute("data-current"));
      if (id === null) return;
      const node = layout.nodes.find((candidate) => candidate.href !== null && tree.units.get(candidate.id)?.kind === "declaration" && decodeURIComponent(candidate.href.slice(1)) === id);
      if (node === undefined) return;
      // Ids hold "\0", which a selector can't name: compared one by one.
      for (const element of svg.querySelectorAll("[data-node]")) {
        if (element.getAttribute("data-node") === node.id) element.setAttribute("data-current", "");
      }
      canvas.current?.show({ x: node.x - node.width / 2, y: node.y - node.height / 2, width: node.width, height: node.height }, { animate: true, margin: 40 });
    };
    window.addEventListener("room:reading", onReading);
    return () => window.removeEventListener("room:reading", onReading);
  }, [layout, tree]);

  return (
    <div ref={viewport} className="relative h-full w-full cursor-grab select-none">
      <div ref={content} className="absolute left-0 top-0">
        <ZoomDrawing layout={layout} tree={tree} counts={counts} onToggle={(id, x, y, open) => onToggle(id, onScreen(x, y), open)} />
      </div>
      <div className="absolute bottom-2 right-2 flex gap-1 text-xs">
        <button type="button" onClick={() => canvas.current?.zoomBy(1.25)} title="Zoom in" className={canvasButton}>
          +
        </button>
        <button type="button" onClick={() => canvas.current?.zoomBy(0.8)} title="Zoom out" className={canvasButton}>
          −
        </button>
        <button type="button" onClick={() => canvas.current?.fit({ maxScale: 1, animate: true })} title="The whole graph" className={canvasButton}>
          Fit
        </button>
      </div>
    </div>
  );
}

const canvasButton =
  "min-w-7 rounded border border-neutral-300 bg-white/90 px-1.5 py-0.5 text-neutral-700 shadow-sm hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900/90 dark:text-neutral-200 dark:hover:bg-neutral-800";

// ---------------------------------------------------------------------------
// The graph, drawn. The declarations' and lines' colours are Ripple's (see
// graphs.tsx, where they aren't exported); a package, folder or file that
// can be opened is drawn heavier, with a "+".

const nodeStyle: Record<string, { box: string; text: string }> = {
  changed: { box: "fill-amber-50 stroke-amber-400 dark:fill-amber-950 dark:stroke-amber-700", text: "fill-amber-950 dark:fill-amber-100" },
  added: { box: "fill-green-50 stroke-green-400 dark:fill-green-950 dark:stroke-green-700", text: "fill-green-950 dark:fill-green-100" },
  removed: { box: "fill-red-50 stroke-red-400 dark:fill-red-950 dark:stroke-red-700", text: "fill-red-900 line-through dark:fill-red-200" },
  affected: { box: "fill-sky-50 stroke-sky-400 dark:fill-sky-950 dark:stroke-sky-700", text: "fill-sky-950 dark:fill-sky-100" },
  unchanged: { box: "fill-white stroke-neutral-300 dark:fill-neutral-950 dark:stroke-neutral-700", text: "fill-neutral-700 dark:fill-neutral-300" },
  external: { box: "fill-violet-50 stroke-violet-300 dark:fill-violet-950 dark:stroke-violet-800", text: "fill-violet-900 dark:fill-violet-200" },
  "unit-changed": { box: "fill-amber-50 stroke-amber-500 dark:fill-amber-950 dark:stroke-amber-600", text: "fill-amber-950 font-semibold dark:fill-amber-100" },
  "unit-affected": { box: "fill-sky-50 stroke-sky-500 dark:fill-sky-950 dark:stroke-sky-600", text: "fill-sky-950 font-semibold dark:fill-sky-100" },
  "unit-unchanged": { box: "fill-white stroke-neutral-400 dark:fill-neutral-950 dark:stroke-neutral-600", text: "fill-neutral-800 font-semibold dark:fill-neutral-200" },
  "unit-outside": { box: "fill-violet-50 stroke-violet-400 dark:fill-violet-950 dark:stroke-violet-700", text: "fill-violet-900 font-semibold dark:fill-violet-200" },
};
const fallbackNode = { box: "fill-white stroke-neutral-300 dark:fill-neutral-950 dark:stroke-neutral-700", text: "fill-neutral-700 dark:fill-neutral-300" };

const edgeStyle: Record<string, { line: string; marker: string; label: string }> = {
  added: { line: "stroke-green-600", marker: "green", label: "fill-green-700 dark:fill-green-400" },
  changed: { line: "stroke-amber-500", marker: "amber", label: "fill-amber-700 dark:fill-amber-400" },
  affected: { line: "stroke-sky-500", marker: "sky", label: "fill-sky-700 dark:fill-sky-400" },
  removed: { line: "stroke-red-500 [stroke-dasharray:5_4]", marker: "red", label: "fill-red-700 dark:fill-red-400" },
};
const fallbackEdge = { line: "stroke-neutral-400", marker: "neutral", label: "fill-neutral-600" };
const markerColor: Record<string, string> = {
  green: "fill-green-600",
  amber: "fill-amber-500",
  sky: "fill-sky-500",
  red: "fill-red-500",
  neutral: "fill-neutral-400",
};

/** A line's width by the uses it carries: one is thin, a hundred is thick, never past 7px. */
const widthOf = (count: number) => Math.min(7, 1.5 + Math.log2(count) * 0.9);

function ZoomDrawing({
  layout,
  tree,
  counts,
  onToggle,
}: {
  layout: GraphLayout;
  tree: ZoomTree;
  counts: Map<string, number>;
  onToggle: (id: string, x: number, y: number, open: boolean) => void;
}) {
  return (
    <svg width={layout.width} height={layout.height} className="block font-mono text-[12px]" role="img" aria-label="Graph">
      <defs>
        {Object.entries(markerColor).map(([name, className]) => (
          // Sized in user units: a thick line doesn't get a huge head.
          <marker key={name} id={`zoom-arrow-${name}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className={className} />
          </marker>
        ))}
      </defs>
      {layout.groups.map((group) => {
        const unit = tree.units.get(group.id);
        const left = group.x - group.width / 2;
        const top = group.y - group.height / 2;
        const outer = unit?.kind === "package" || unit?.kind === "outside";
        // A file's box links to its code beside its name.
        const fileHref = unit?.kind === "file" ? layoutFileHref(layout, group.id) : null;
        return (
          <g key={group.id}>
            <rect
              x={left}
              y={top}
              width={group.width}
              height={group.height}
              rx={outer ? 10 : 6}
              strokeWidth={outer ? 1.5 : 1}
              className={
                outer
                  ? "fill-indigo-50/40 stroke-indigo-300 dark:fill-indigo-950/30 dark:stroke-indigo-800"
                  : unit?.kind === "file"
                    ? "fill-white/70 stroke-neutral-300 dark:fill-neutral-900/50 dark:stroke-neutral-700"
                    : "fill-neutral-50/60 stroke-neutral-200 dark:fill-neutral-900/40 dark:stroke-neutral-800"
              }
            />
            <text
              x={left + (outer ? 12 : 6)}
              y={outer ? top + 19 : top - 5}
              onClick={(event) => {
                event.stopPropagation();
                onToggle(group.id, left, top, false);
              }}
              className={`cursor-pointer hover:underline ${outer ? "fill-indigo-900 font-sans text-[14px] font-semibold dark:fill-indigo-200" : "fill-neutral-600 text-[11px] dark:fill-neutral-400"}`}
            >
              <title>{`${unit?.title ?? group.label}: click to close`}</title>
              {`− ${group.label}`}
            </text>
            {fileHref !== null && (
              <a href={fileHref}>
                <text x={left + 6 + (group.label.length + 2) * 6.6 + 8} y={top - 5} className="fill-blue-600 text-[11px] hover:underline dark:fill-blue-400">
                  code ↓
                </text>
              </a>
            )}
          </g>
        );
      })}
      {layout.edges.map((edge, index) => {
        const style = edgeStyle[edge.kind] ?? fallbackEdge;
        const count = counts.get(`${edge.from}\u0001${edge.to}\u0001${edge.kind}`) ?? 1;
        const middle = middleOf(edge.points);
        return (
          <g key={index}>
            <path d={cornersOf(edge.points)} fill="none" strokeWidth={widthOf(count)} markerEnd={`url(#zoom-arrow-${style.marker})`} className={style.line}>
              <title>{edge.title}</title>
            </path>
            {count > 1 && middle !== null && (
              <text
                x={middle.x}
                y={middle.y - 4}
                textAnchor="middle"
                className={`${style.label} stroke-white font-sans text-[10px] font-semibold [paint-order:stroke] [stroke-width:3px] dark:stroke-neutral-950`}
              >
                <title>{edge.title}</title>
                {count}
              </text>
            )}
          </g>
        );
      })}
      {layout.nodes.map((node) => {
        const unit = tree.units.get(node.id);
        const style = nodeStyle[node.kind] ?? fallbackNode;
        const opens = unit !== undefined && unit.kind !== "declaration" && unit.children.length > 0;
        const left = node.x - node.width / 2;
        const top = node.y - node.height / 2;
        const box = (
          <g>
            <title>{node.title}</title>
            <rect x={left} y={top} width={node.width} height={node.height} rx={opens ? 6 : 4} strokeWidth={opens ? 2 : 1.25} className={style.box} />
            <text x={node.x} y={node.note === null ? node.y + 4 : node.y - 3} textAnchor="middle" className={style.text}>
              {shorten(node.label)}
            </text>
            {node.note !== null && (
              <text x={node.x} y={node.y + 12} textAnchor="middle" className="fill-neutral-500 font-sans text-[10px]">
                {node.note}
              </text>
            )}
            {opens && (
              <text x={left + node.width - 8} y={top + 11} textAnchor="middle" className="fill-neutral-400 font-sans text-[11px] font-semibold">
                +
              </text>
            )}
          </g>
        );
        const marks = "[&[data-current]_rect]:stroke-blue-600 [&[data-current]_rect]:[stroke-width:3px]";
        if (opens) {
          return (
            <g key={node.id} data-node={node.id} onClick={() => onToggle(node.id, left, top, true)} className={`cursor-pointer [&:hover_rect]:stroke-blue-500 ${marks}`}>
              {box}
            </g>
          );
        }
        return node.href === null ? (
          <g key={node.id} data-node={node.id} className={marks}>
            {box}
          </g>
        ) : (
          <a key={node.id} href={node.href} data-node={node.id} className={`cursor-pointer [&:hover_rect]:stroke-blue-500 ${marks}`}>
            {box}
          </a>
        );
      })}
    </svg>
  );
}

/** An open file's code on the page: from one of its declarations' links ("#file-3--name" → "#file-3"). */
function layoutFileHref(layout: GraphLayout, group: string): string | null {
  const href = layout.nodes.find((node) => node.group === group && node.href !== null)?.href ?? null;
  return href === null ? null : href.split("--")[0] ?? null;
}

/** Halfway along a line: where its number goes. */
function middleOf(points: Array<{ x: number; y: number }>): { x: number; y: number } | null {
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - (points[index]?.x ?? 0), point.y - (points[index]?.y ?? 0)));
  let left = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index] ?? 0;
    const from = points[index];
    const to = points[index + 1];
    if (from === undefined || to === undefined) continue;
    if (left <= length && length > 0) return { x: from.x + ((to.x - from.x) * left) / length, y: from.y + ((to.y - from.y) * left) / length };
    left -= length;
  }
  return points[0] ?? null;
}

/** Through the edge's points in straight runs, each corner rounded by at most 8px (as Ripple's, see graphs.tsx). */
function cornersOf(points: Array<{ x: number; y: number }>): string {
  const [first] = points;
  if (first === undefined) return "";
  let path = `M ${first.x} ${first.y}`;
  for (let index = 1; index < points.length; index++) {
    const corner = points[index];
    const previous = points[index - 1];
    const next = points[index + 1];
    if (corner === undefined || previous === undefined) continue;
    if (next === undefined) {
      path += ` L ${corner.x} ${corner.y}`;
      continue;
    }
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const radius = Math.min(8, inLength / 2, outLength / 2);
    if (radius < 0.5) {
      path += ` L ${corner.x} ${corner.y}`;
      continue;
    }
    const before = { x: corner.x - ((corner.x - previous.x) / inLength) * radius, y: corner.y - ((corner.y - previous.y) / inLength) * radius };
    const after = { x: corner.x + ((next.x - corner.x) / outLength) * radius, y: corner.y + ((next.y - corner.y) / outLength) * radius };
    path += ` L ${before.x} ${before.y} Q ${corner.x} ${corner.y} ${after.x} ${after.y}`;
  }
  return path;
}

/** A label that doesn't fit (48 characters, see the layout) loses its start: the end of a path says most. */
function shorten(label: string): string {
  return label.length > 48 ? `…${label.slice(-47)}` : label;
}
