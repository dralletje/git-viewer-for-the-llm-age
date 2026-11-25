import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { attachCanvas, type Canvas } from "@room/canvas";
import { useFetcher } from "react-router";
import type { ChangeView } from "#/components/changes.tsx";
import type { ChangesGraph } from "#/graph.server.ts";
import { layoutGraphElk } from "#/graph-layout-elk.ts";
import { appBoxesGraph, layoutGraph, rippleWithoutFileBoxes, type Graph, type GraphFile, type GraphLayout } from "#/graphs.ts";

/** The declaration graph of the changes: null while it's being found, or on a tab that doesn't need it. */
const GraphContext = createContext<ChangesGraph | null>(null);

/**
 * Fetches the declaration graph from `href` (the graph route) on the tabs
 * that draw it (`enabled`), and provides it. Its own request, as the
 * reach's: a first scan takes a while.
 */
export function GraphProvider({ href, enabled, children }: { href: string; enabled: boolean; children: ReactNode }) {
  const fetcher = useFetcher<{ graph: ChangesGraph }>();
  // Which href the fetcher's data is for: another page's is stale.
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || loaded === href) return;
    fetcher.load(href);
    setLoaded(href);
    // Only a new href, or turning it on, loads; `fetcher` is a new object every render.
  }, [href, enabled]);
  const graph = loaded === href && fetcher.state === "idle" ? (fetcher.data?.graph ?? null) : null;
  return <GraphContext.Provider value={graph}>{children}</GraphContext.Provider>;
}

/**
 * Above the files on the Ripple tabs, once the graph is found: what the
 * changes spread to, in a box per app or package, with a box per file in
 * those ("combined": Ripple) or without ("flat"). `pageTitle`: what these
 * changes are, for the bar over the drawing.
 */
export function GraphPanel({ view, files, pageTitle }: { view: ChangeView; files: Array<GraphFile>; pageTitle: string }) {
  const data = useContext(GraphContext);
  if (data === null) return <GraphNote>Following the changes through the repository's declarations…</GraphNote>;
  if (data.status === "too-large") return <GraphNote>Not scanned: {data.sourceFiles} source files is more than a page can wait for.</GraphNote>;
  if (data.status === "failed") return <GraphNote>The declarations couldn't be followed: {data.message}</GraphNote>;

  const legend = (
    <>
      <Swatch className="border-amber-400 bg-amber-50 dark:bg-amber-950">changed</Swatch>
      <Swatch className="border-green-400 bg-green-50 dark:bg-green-950">new</Swatch>
      <Swatch className="border-sky-400 bg-sky-50 dark:bg-sky-950">same code, uses what changed</Swatch>
      <Line className="stroke-green-600">a use that's new</Line>
      <Line className="stroke-red-500" dashed>
        a use that went away
      </Line>
      <Swatch className="border-indigo-300 bg-indigo-50 dark:bg-indigo-950">an app or package (its package.json's folder)</Swatch>
      <span className="inline-flex items-center gap-1">
        <svg width="22" height="8" aria-hidden className="shrink-0">
          <line x1="0" y1="4" x2="22" y2="4" strokeWidth="2.5" className="stroke-neutral-500" />
        </svg>
        a use from one app or package into another
      </span>
      <span>
        An arrow points from what's used to what uses it: the way a change spreads.
        {data.ripple.affected > data.ripple.shown && ` The nearest ${data.ripple.shown} of ${data.ripple.affected} affected declarations.`}
      </span>
      <span>Click a declaration to see only the paths through it; click the background to see everything.</span>
    </>
  );
  if (view === "flat") {
    return (
      <GraphFrame
        title="What the changes spread to, and the uses they added or removed, in a box per app or package (no box per file)"
        legend={legend}
        graph={rippleWithoutFileBoxes(data, files)}
        empty="No code that runs changed."
        barTitle={pageTitle}
      />
    );
  }
  return (
    <GraphFrame
      title="What the changes spread to, and the uses they added or removed, in a box per app or package"
      legend={legend}
      graph={appBoxesGraph(data, files)}
      empty="No code that runs changed."
      barTitle={pageTitle}
    />
  );
}

function GraphNote({ children }: { children: ReactNode }) {
  return <p className="mt-2 rounded-md border border-neutral-200 px-4 py-3 text-xs text-neutral-500 dark:border-neutral-800">{children}</p>;
}

/**
 * A graph, laid out (ELK, or dagre to compare) and drawn on a canvas stuck
 * to the top of the code, as tall as dragged. Its header (title, layout,
 * legend) scrolls away above it; `barTitle` stays, on the bar over the
 * drawing.
 */
function GraphFrame({ title, legend, graph, empty, barTitle }: { title: string; legend: ReactNode; graph: Graph; empty: string; barTitle: string }) {
  // Which layout draws it: ELK, or dagre to compare.
  const [engine, setEngine] = useState<"elk" | "dagre">("elk");

  // The sticky graph's height: dragged at its bottom edge, kept in this
  // browser. 0: the first 45% of the screen.
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
    // 24px: the sticky graph covers the code column's padding (-top-6).
    const update = () => column.style.setProperty("--files-top", `${element.offsetHeight - 24}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      column.style.removeProperty("--files-top");
    };
  }, []);
  // Laying out is the costly part: only again when the graph is another.
  const key = JSON.stringify(graph);
  const dagreLayout = useMemo(() => (engine !== "dagre" || graph.nodes.length === 0 ? null : layoutGraph(graph)), [key, engine]);
  // ELK answers with a promise: which graph its layout is for, so another's isn't drawn.
  const [elkLayout, setElkLayout] = useState<{ key: string; layout: GraphLayout | null; error: string | null } | null>(null);
  useEffect(() => {
    if (engine !== "elk" || graph.nodes.length === 0) return;
    let current = true;
    layoutGraphElk(graph).then(
      (layout) => current && setElkLayout({ key, layout, error: null }),
      (error: unknown) => current && setElkLayout({ key, layout: null, error: String(error) }),
    );
    return () => {
      current = false;
    };
  }, [key, engine]);
  const elkReady = elkLayout !== null && elkLayout.key === key ? elkLayout : null;
  const layout = graph.nodes.length === 0 ? null : engine === "dagre" ? dagreLayout : (elkReady?.layout ?? null);
  const placing = graph.nodes.length > 0 && engine === "elk" && elkReady === null;

  const drawing = placing ? (
    <p className="px-4 py-3 text-xs text-neutral-500">Placing {graph.nodes.length} declarations…</p>
  ) : elkReady?.error != null && engine === "elk" ? (
    <p className="px-4 py-3 text-xs text-red-600 dark:text-red-400">ELK couldn't place this graph: {elkReady.error}</p>
  ) : layout === null ? (
    <p className="px-4 py-3 text-xs text-neutral-500">{empty}</p>
  ) : (
    <GraphCanvas layout={layout} roundedCorners={engine === "elk"} />
  );

  // The header scrolls away; the drawing sticks to the top of the code, the
  // column's whole width, over its padding (-top-6, -mx-6), so no code
  // shows beside or above it. Both are the code column's own children (see
  // ChangesPage): a sticky element only sticks within its parent.
  return (
    <>
      <header className="py-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">{title}</h3>
          <span className="text-[11px] text-neutral-500">Drag or scroll to move, pinch or ctrl + scroll to zoom. Click a declaration: its code below.</span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-neutral-500">
            Layout
            {(["elk", "dagre"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setEngine(option)}
                aria-pressed={engine === option}
                className={`rounded border px-1.5 py-0.5 ${engine === option ? "border-neutral-400 bg-neutral-100 text-neutral-900 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100" : "border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"}`}
              >
                {option === "elk" ? "ELK" : "dagre"}
              </button>
            ))}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
          {legend}
          {graph.edges.some((edge) => edge.kind === "point") && (
            <Line className="stroke-fuchsia-600 dark:stroke-fuchsia-400" dashed>
              reaches one of the repository's points (hover: the way there)
            </Line>
          )}
        </div>
        {layout?.withoutBoxes === true && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Drawn without boxes: the layout couldn't place this graph in them. Hover a declaration for its file.</p>
        )}
      </header>
      <div
        ref={sticky}
        data-sticky-graph
        style={{ height: height > 0 ? `${height}px` : "45vh" }}
        className="sticky -top-6 z-20 -mx-6 flex flex-col border-y border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
      >
        {/* Once the header has scrolled away: what these changes are, and the way back up. */}
        <div className="flex h-6 shrink-0 items-center gap-2 border-b border-neutral-100 px-3 text-[11px] text-neutral-500 dark:border-neutral-900">
          <span className="min-w-0 flex-1 truncate">{barTitle}</span>
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

/**
 * The drawing on a canvas (see @room/canvas): moved by dragging or
 * scrolling, zoomed by pinching, fitted at first. Follows the code: the
 * declaration being read below (ChangesView's "room:reading" event) is
 * marked, and moved into sight. Clicking a declaration focuses it: all but
 * the paths through it fade.
 */
function GraphCanvas({ layout, roundedCorners }: { layout: GraphLayout; roundedCorners: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const canvas = useRef<Canvas | null>(null);

  useEffect(() => {
    const frame = viewport.current;
    const drawing = content.current;
    if (frame === null || drawing === null) return;
    const attached = attachCanvas(frame, drawing, { size: { width: layout.width, height: layout.height }, minScale: 0.05, maxScale: 3 });
    // The whole graph at first, never larger than drawn.
    attached.fit({ maxScale: 1 });
    canvas.current = attached;
    return () => {
      attached.destroy();
      canvas.current = null;
    };
  }, [layout]);

  // Focus on click: the paths through the clicked declaration, the rest
  // faded; the background clears it. The click goes on to the code, too.
  // The page hears of it ("room:focus", see ChangesView): the files the
  // paths go through stay, the rest are hidden below and dimmed in the
  // tree. Choosing a file in the tree ends it ("room:focus-clear").
  useEffect(() => {
    const frame = viewport.current;
    const drawing = content.current;
    if (frame === null || drawing === null) return;
    const tell = (files: Array<string> | null) => window.dispatchEvent(new CustomEvent("room:focus", { detail: { files } }));
    const clear = () => {
      drawing.querySelectorAll("[data-dim]").forEach((element) => element.removeAttribute("data-dim"));
    };
    const onClick = (event: MouseEvent) => {
      // Zoom and Fit keep the focus.
      if (event.target instanceof Element && event.target.closest("button") !== null) return;
      const clicked = event.target instanceof Element ? event.target.closest("[data-node]")?.getAttribute("data-node") : null;
      const elements = drawing.querySelectorAll("[data-node], path[data-from]");
      if (clicked === null || clicked === undefined) {
        clear();
        tell(null);
        return;
      }
      // Upstream (what it uses, and so on) and downstream (what uses it).
      const kept = new Set([clicked]);
      for (const forward of [true, false]) {
        const queue = [clicked];
        for (let index = 0; index < queue.length; index++) {
          for (const edge of layout.edges) {
            const [from, to] = forward ? [edge.from, edge.to] : [edge.to, edge.from];
            if (from !== queue[index] || kept.has(to)) continue;
            kept.add(to);
            queue.push(to);
          }
        }
      }
      elements.forEach((element) => {
        const node = element.getAttribute("data-node");
        const dim = node !== null ? !kept.has(node) : !(kept.has(element.getAttribute("data-from") ?? "") && kept.has(element.getAttribute("data-to") ?? ""));
        element.toggleAttribute("data-dim", dim);
      });
      // The files on the page the paths go through: from each node's link ("#file-3--name").
      const files = new Set<string>();
      for (const node of layout.nodes) {
        if (kept.has(node.id) && node.href !== null) files.add(decodeURIComponent(node.href.slice(1)).split("--")[0] ?? "");
      }
      tell([...files]);
    };
    frame.addEventListener("click", onClick);
    window.addEventListener("room:focus-clear", clear);
    return () => {
      frame.removeEventListener("click", onClick);
      window.removeEventListener("room:focus-clear", clear);
      // Another graph, or another tab: the page shows every file again.
      tell(null);
    };
  }, [layout]);

  // The declaration being read in the code: its node marked and in sight.
  useEffect(() => {
    const onReading = (event: Event) => {
      const id = (event as CustomEvent<{ id: string | null }>).detail.id;
      const svg = content.current;
      if (svg === null) return;
      svg.querySelectorAll("[data-current]").forEach((element) => element.removeAttribute("data-current"));
      if (id === null) return;
      const node = layout.nodes.find((candidate) => candidate.href !== null && decodeURIComponent(candidate.href.slice(1)) === id);
      if (node === undefined) return;
      // Ids hold "\0", which a selector can't name: compared one by one.
      for (const element of svg.querySelectorAll("[data-node]")) {
        if (element.getAttribute("data-node") === node.id) element.setAttribute("data-current", "");
      }
      const attached = canvas.current;
      const frame = viewport.current;
      if (attached === null || frame === null) return;
      // Zoomed out too far to read (a big graph, fitted): zoom in on it.
      if (attached.view().scale < 0.5) {
        const scale = 0.8;
        attached.setView({ x: frame.clientWidth / 2 - node.x * scale, y: frame.clientHeight / 2 - node.y * scale, scale }, { animate: true });
        return;
      }
      attached.show({ x: node.x - node.width / 2, y: node.y - node.height / 2, width: node.width, height: node.height }, { animate: true, margin: 40 });
    };
    window.addEventListener("room:reading", onReading);
    return () => window.removeEventListener("room:reading", onReading);
  }, [layout]);

  return (
    <div ref={viewport} className="relative h-full w-full cursor-grab select-none">
      <div ref={content} className="absolute left-0 top-0">
        <GraphDrawing layout={layout} roundedCorners={roundedCorners} />
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

function Swatch({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-3 w-4 rounded-sm border ${className}`} />
      {children}
    </span>
  );
}

function Line({ className, dashed = false, children }: { className: string; dashed?: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      <svg width="22" height="8" aria-hidden>
        <line x1="1" y1="4" x2="21" y2="4" strokeWidth="2" strokeDasharray={dashed ? "4 3" : undefined} className={className} />
      </svg>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The graph, drawn.

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

/** Each edge kind: its line, and which arrowhead (by color). */
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
 * The graph as SVG. `roundedCorners`: the lines are straight runs (ELK's),
 * drawn with small rounded corners; else they're curved through their
 * points (dagre's). A node marked `data-current` (the declaration being
 * read, see GraphCanvas) is drawn heavier; one marked `data-dim` (focus,
 * see GraphCanvas), and a line, faded.
 */
function GraphDrawing({ layout, roundedCorners }: { layout: GraphLayout; roundedCorners: boolean }) {
  return (
    <svg width={layout.width} height={layout.height} className="block font-mono text-[12px]" role="img" aria-label="Graph">
      <defs>
        {Object.entries(markerColor).map(([name, className]) => (
          <marker key={name} id={`arrow-${name}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className={className} />
          </marker>
        ))}
      </defs>
      {layout.groups.map((group) =>
        // An app or package (see appBoxesGraph): around its files' boxes, its name inside its top edge.
        group.id.startsWith("package:") ? (
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
        ) : (
          <g key={group.id}>
            <rect
              x={group.x - group.width / 2}
              y={group.y - group.height / 2}
              width={group.width}
              height={group.height}
              rx="6"
              className="fill-neutral-50/60 stroke-neutral-200 dark:fill-neutral-900/40 dark:stroke-neutral-800"
            />
            <text x={group.x - group.width / 2 + 6} y={group.y - group.height / 2 - 5} className="fill-neutral-500 text-[11px]">
              {group.label}
            </text>
          </g>
        ),
      )}
      {layout.edges.map((edge, index) => {
        const style = edgeStyle[edge.kind] ?? fallbackEdge;
        return (
          <path
            key={index}
            d={roundedCorners ? cornersOf(edge.points) : pathOf(edge.points)}
            fill="none"
            strokeWidth={edge.wide === true ? 2.5 : 1.5}
            markerEnd={`url(#arrow-${style.marker})`}
            data-from={edge.from}
            data-to={edge.to}
            className={`${style.line} transition-opacity [&[data-dim]]:opacity-10`}
          >
            <title>{edge.title}</title>
          </path>
        );
      })}
      {layout.nodes.map((node) => {
        const style = nodeStyle[node.kind] ?? fallbackNode;
        const box = (
          <g>
            <title>{node.title}</title>
            <rect x={node.x - node.width / 2} y={node.y - node.height / 2} width={node.width} height={node.height} rx="4" strokeWidth="1.25" className={style.box} />
            <text x={node.x} y={node.note === null ? node.y + 4 : node.y - 3} textAnchor="middle" className={style.text}>
              {shorten(node.label)}
            </text>
            {node.note !== null && (
              <text x={node.x} y={node.y + 12} textAnchor="middle" className="fill-neutral-500 font-sans text-[10px]">
                {node.note}
              </text>
            )}
          </g>
        );
        const marks = "transition-opacity [&[data-dim]]:opacity-15 [&[data-current]_rect]:stroke-blue-600 [&[data-current]_rect]:[stroke-width:3px]";
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

/** Through the edge's points in straight runs, each corner rounded by at most 8px. */
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
    // Back from the corner along the way in, and on along the way out.
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

/** A label that doesn't fit (48 characters, see `layoutGraph`) loses its start: the end of a path says most. */
function shorten(label: string): string {
  return label.length > 48 ? `…${label.slice(-47)}` : label;
}

/** Through the edge's points, rounded at each bend. */
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
