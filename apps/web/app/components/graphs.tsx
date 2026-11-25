import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { attachCanvas, type Canvas } from "@room/canvas";
import { useFetcher } from "react-router";
import type { AnalyzedDeclaration, AnalyzedFile } from "#/analyze-diff.server.ts";
import type { ChangeView } from "#/components/changes.tsx";
import type { ChangesGraph, GraphDeclaration } from "#/graph.server.ts";
import { layoutGraphElk } from "#/graph-layout-elk.ts";
import { appBoxesGraph, bundledGraph, combinedGraph, foldedGraph, layoutGraph, neighborsOf, reachFlowGraph, type Graph, type GraphFile, type GraphLayout, type ScannedGraph } from "#/graphs.ts";

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
 * Above the files on a graph tab or Calls: what it shows, once the graph is
 * found. With `fill`, a graph fills the height it's given (its drawing
 * scrolls inside it) and its legend is folded away.
 */
export function GraphPanel({ view, files, fill = false, pageTitle }: { view: ChangeView; files: Array<GraphFile>; fill?: boolean; pageTitle?: string }) {
  const data = useContext(GraphContext);
  // Far files folded (see foldedGraph): the boxes opened by a click.
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  if (data === null) return <GraphNote>Following the changes through the repository's declarations…</GraphNote>;
  if (data.status === "too-large") return <GraphNote>Not scanned: {data.sourceFiles} source files is more than a page can wait for.</GraphNote>;
  if (data.status === "failed") return <GraphNote>The declarations couldn't be followed: {data.message}</GraphNote>;

  if (view === "calls") return <CallsPanel data={data} files={files} />;
  if (view === "points") return <PointsPanel data={data} files={files} />;

  if (view === "combined" || view === "folded" || view === "bundled" || view === "zoom") {
    const rippleLegend = (
      <>
        <Swatch className="border-amber-400 bg-amber-50 dark:bg-amber-950">changed</Swatch>
        <Swatch className="border-green-400 bg-green-50 dark:bg-green-950">new</Swatch>
        <Swatch className="border-sky-400 bg-sky-50 dark:bg-sky-950">same code, uses what changed</Swatch>
        <Line className="stroke-green-600">a use that's new</Line>
        <Line className="stroke-red-500" dashed>
          a use that went away
        </Line>
        <span>
          An arrow points from what's used to what uses it: the way a change spreads.
          {data.ripple.affected > data.ripple.shown && ` The nearest ${data.ripple.shown} of ${data.ripple.affected} affected declarations.`}
        </span>
        <span>Click a declaration to see only the paths through it; click the background to see everything.</span>
      </>
    );
    if (view === "folded") {
      return (
        <GraphFrame
          title="What the changes spread to: files 3 or more steps away folded"
          legend={
            <>
              {rippleLegend}
              <Swatch className="border-dashed border-neutral-400 bg-neutral-50 dark:bg-neutral-900">a folded file: click to open it</Swatch>
            </>
          }
          graph={foldedGraph(data, files, opened)}
          empty="No code that runs changed."
          fill={fill} barTitle={pageTitle}
          onToggle={(group) => setOpened((before) => new Set(before).add(group))}
        />
      );
    }
    if (view === "bundled") {
      return (
        <GraphFrame
          title="What the changes spread to: one line per file"
          legend={
            <>
              {rippleLegend}
              <Swatch className="rounded-full border-sky-400 bg-white dark:bg-neutral-950">a bundle: that many arrows, fanned out in the box</Swatch>
            </>
          }
          graph={bundledGraph(data, files)}
          empty="No code that runs changed."
          fill={fill} barTitle={pageTitle}
        />
      );
    }
    if (view === "zoom") {
      return (
        <GraphFrame
          title="What the changes spread to: zoom in for detail"
          legend={
            <>
              {rippleLegend}
              <span>Zoomed out: each file's name and how many declarations; zoom in for their names.</span>
            </>
          }
          graph={combinedGraph(data, files)}
          empty="No code that runs changed."
          fill={fill} barTitle={pageTitle}
          overview
        />
      );
    }
    return (
      <GraphFrame
        title="What the changes spread to, and the uses they added or removed, in a box per app or package"
        legend={
          <>
            {rippleLegend}
            <Swatch className="border-indigo-300 bg-indigo-50 dark:bg-indigo-950">an app or package (its package.json's folder)</Swatch>
            <span className="inline-flex items-center gap-1">
              <svg width="22" height="8" aria-hidden className="shrink-0">
                <line x1="0" y1="4" x2="22" y2="4" strokeWidth="3.5" className="stroke-neutral-500" />
              </svg>
              a use from one app or package into another
            </span>
          </>
        }
        graph={appBoxesGraph(data, files)}
        empty="No code that runs changed."
        fill={fill} barTitle={pageTitle}
      />
    );
  }

  return (
    <GraphFrame
      title="New reach, declaration by declaration"
      legend={
        <>
          <Line className="stroke-green-600">added by these changes</Line>
          <Line className="stroke-neutral-400">was already there</Line>
          <span>
            Declarations on the left, then what gives it (a package, a global, a point's own code), then the point or capability on the right. Tests and
            stories left out.
          </span>
        </>
      }
      graph={reachFlowGraph(data, files)}
      empty="No declaration reaches anything new."
    />
  );
}

function GraphNote({ children }: { children: ReactNode }) {
  return <p className="mt-2 rounded-md border border-neutral-200 px-4 py-3 text-xs text-neutral-500 dark:border-neutral-800">{children}</p>;
}

/**
 * A graph, laid out (ELK, or dagre to compare) and drawn. With `fill`, it's
 * drawn on a canvas stuck to the top of the code, as tall as dragged.
 * `onToggle`: what clicking a folded node opens (see foldedGraph);
 * `overview`: zoomed out, each file's name instead of its declarations';
 */
function GraphFrame({
  title,
  legend,
  graph,
  empty,
  fill = false,
  barTitle,
  onToggle,
  overview = false,
}: {
  title: string;
  legend: ReactNode;
  graph: Graph;
  empty: string;
  fill?: boolean;
  /** With `fill`: the line on the bar above the drawing, once the page's header has scrolled away: what these changes are (a commit's subject). */
  barTitle?: string;
  onToggle?: (toggle: string) => void;
  overview?: boolean;
}) {
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
    if (!fill || element === null || element === undefined || column === null || column === undefined) return;
    // 24px: the sticky graph covers the code column's padding (-top-6).
    const update = () => column.style.setProperty("--files-top", `${element.offsetHeight - 24}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      column.style.removeProperty("--files-top");
    };
  }, [fill]);
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
  const legendLine = (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
      {legend}
      {graph.edges.some((edge) => edge.kind === "point") && (
        <Line className="stroke-fuchsia-600 dark:stroke-fuchsia-400" dashed>
          reaches one of the repository's points (hover: the way there)
        </Line>
      )}
    </div>
  );
  const header = (
    <header className={fill ? "py-2" : "border-b border-neutral-200 px-4 py-2 dark:border-neutral-800"}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        {fill && <span className="text-[11px] text-neutral-500">Drag or scroll to move, pinch or ctrl + scroll to zoom. Click a declaration: its code below.</span>}
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
      {legendLine}
      {layout?.withoutBoxes === true && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          Drawn without a box per file: the layout couldn't place this graph in boxes. Hover a declaration for its file.
        </p>
      )}
    </header>
  );
  const drawing = placing ? (
    <p className="px-4 py-3 text-xs text-neutral-500">Placing {graph.nodes.length} declarations…</p>
  ) : elkReady?.error != null && engine === "elk" ? (
    <p className="px-4 py-3 text-xs text-red-600 dark:text-red-400">ELK couldn't place this graph: {elkReady.error}</p>
  ) : layout === null ? (
    <p className="px-4 py-3 text-xs text-neutral-500">{empty}</p>
  ) : fill ? (
    <GraphCanvas layout={layout} roundedCorners={engine === "elk"} onToggle={onToggle} overview={overview} />
  ) : (
    <GraphSvg layout={layout} roundedCorners={engine === "elk"} />
  );

  if (fill) {
    // The header scrolls away; the drawing sticks to the top of the code,
    // the column's whole width, over its padding (-top-6, -mx-6), so no
    // code shows beside or above it. Both are the code column's own
    // children (see ChangesPage): a sticky element only sticks within its
    // parent.
    return (
      <>
        {header}
        <div
          ref={sticky}
          data-sticky-graph
          style={{ height: height > 0 ? `${height}px` : "45vh" }}
          className="sticky -top-6 z-20 -mx-6 flex flex-col border-y border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
        >
          {/* Once the header has scrolled away: what this is, and the way back up to it. */}
          <div className="flex h-6 shrink-0 items-center gap-2 border-b border-neutral-100 px-3 text-[11px] text-neutral-500 dark:border-neutral-900">
            <span className="min-w-0 flex-1 truncate">{barTitle ?? title}</span>
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
  return (
    <section className="mt-2 rounded-md border border-neutral-200 dark:border-neutral-800">
      {header}
      {drawing}
    </section>
  );
}

/**
 * The drawing on a canvas (see @room/canvas): moved by dragging or
 * scrolling, zoomed by pinching, fitted at first. Follows the code: the
 * declaration being read below (ChangesView's "room:reading" event) is
 * marked, and moved into sight. Clicking a declaration focuses it: all but
 * the paths through it fade.
 */
function GraphCanvas({
  layout,
  roundedCorners,
  onToggle,
  overview,
}: {
  layout: GraphLayout;
  roundedCorners: boolean;
  onToggle?: (toggle: string) => void;
  overview: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const canvas = useRef<Canvas | null>(null);
  // A folded file just opened: the new layout is shown around its box, at the scale it was at.
  const opening = useRef<{ group: string; scale: number } | null>(null);

  useEffect(() => {
    const frame = viewport.current;
    const drawing = content.current;
    if (frame === null || drawing === null) return;
    const attached = attachCanvas(frame, drawing, {
      size: { width: layout.width, height: layout.height },
      minScale: 0.05,
      maxScale: 3,
      // Detail by zoom: far out, the files' names (see GraphDrawing's `overview`), kept as large on screen.
      onChange: overview
        ? (view) => {
            drawing.toggleAttribute("data-far", view.scale < 0.45);
            drawing.style.setProperty("--inverse-scale", String(1 / view.scale));
          }
        : undefined,
    });
    const box = opening.current === null ? undefined : layout.groups.find((group) => group.id === opening.current?.group);
    if (box !== undefined && opening.current !== null) {
      const scale = opening.current.scale;
      attached.setView({ x: frame.clientWidth / 2 - box.x * scale, y: frame.clientHeight / 2 - box.y * scale, scale });
    } else {
      // The whole graph at first, never larger than drawn.
      attached.fit({ maxScale: 1 });
    }
    opening.current = null;
    canvas.current = attached;
    return () => {
      attached.destroy();
      canvas.current = null;
    };
  }, [layout, overview]);

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
      <div ref={content} className="group/canvas absolute left-0 top-0">
        <GraphDrawing
          layout={layout}
          roundedCorners={roundedCorners}
          overview={overview}
          onToggle={
            onToggle === undefined
              ? undefined
              : (toggle) => {
                  opening.current = { group: toggle, scale: canvas.current?.view().scale ?? 1 };
                  onToggle(toggle);
                }
          }
        />
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
// Points.

const capabilityChip = "rounded bg-neutral-900 px-1.5 font-sans text-[10px] font-semibold text-white dark:bg-neutral-100 dark:text-neutral-900";
const pointChip = "rounded bg-fuchsia-700 px-1.5 font-sans text-[10px] font-semibold text-white dark:bg-fuchsia-300 dark:text-fuchsia-950";

/** A target's chip: a point (the repository's own) or a capability. */
function TargetChip({ data, target }: { data: ScannedGraph; target: string }) {
  const found = data.targets[target];
  if (found === undefined) return null;
  return (
    <span title={found.about ?? undefined} className={found.kind === "point" ? pointChip : capabilityChip}>
      {found.label}
    </span>
  );
}

/**
 * What matters in the repository (its `.room.toml` points, then the
 * capabilities), and the changed or affected declarations that reach each,
 * with the way there. A point the changes don't reach says so.
 */
function PointsPanel({ data, files }: { data: ScannedGraph; files: Array<GraphFile> }) {
  const hrefOf = new Map(files.map(({ file, href }) => [file.path, href]));
  const hasPoints = Object.values(data.targets).some((target) => target.kind === "point");
  return (
    <section className="mt-2 rounded-md border border-neutral-200 dark:border-neutral-800">
      <header className="border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <h3 className="text-sm font-medium">What the changes reach</h3>
        <p className="mt-1 text-xs text-neutral-500">
          The repository's points (its <span className="font-mono">.room.toml</span>), then what else the changed code can reach, and the declarations that
          changed or use what changed that get there. Through a point's own code, only the point counts.
        </p>
        {!hasPoints && (
          <p className="mt-1 text-xs text-neutral-500">
            No points yet: name what matters in a <span className="font-mono">.room.toml</span> at the repository's root, as{" "}
            <span className="font-mono">[[points]] name = "Medplum" packages = ["@medplum/*"]</span>, or with <span className="font-mono">files</span> or{" "}
            <span className="font-mono">declarations</span> (<span className="font-mono">"path#name"</span>).
          </p>
        )}
        {data.problems.map((problem) => (
          <p key={problem} className="mt-1 text-xs text-red-700 dark:text-red-400">
            {problem}
          </p>
        ))}
      </header>
      {data.points.length === 0 ? (
        <p className="px-4 py-3 text-xs text-neutral-500">The changed code reaches nothing that matters.</p>
      ) : (
        <ul>
          {data.points.map((entry) => (
            <li key={entry.target} className="border-b border-neutral-200 px-4 py-3 text-xs last:border-b-0 dark:border-neutral-800">
              <div className="flex flex-wrap items-center gap-2">
                <TargetChip data={data} target={entry.target} />
                {data.targets[entry.target]?.about !== null && <span className="text-neutral-600 dark:text-neutral-400">{data.targets[entry.target]?.about}</span>}
                <span className="text-neutral-500">
                  {entry.count === 0 ? "not reached by these changes" : `reached by ${entry.count} ${entry.count === 1 ? "declaration" : "declarations"} that changed or use what changed`}
                </span>
              </div>
              {entry.reachedBy.length > 0 && (
                <ul className="mt-1.5 flex flex-col gap-1 pl-3">
                  {entry.reachedBy.map((reacher) => (
                    <li key={reacher.id} className="flex flex-wrap items-baseline gap-x-1.5">
                      <DeclarationChip declaration={data.declarations[reacher.id]} href={hrefOf.get(data.declarations[reacher.id]?.path ?? "") ?? null} />
                      <span className="text-neutral-500">
                        {reacher.chain.length === 0 ? (
                          "is part of it"
                        ) : (
                          <>
                            → <span className="font-mono">{reacher.chain.map((id) => data.declarations[id]?.label ?? "?").join(" → ")}</span>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                  {entry.count > entry.reachedBy.length && <li className="text-neutral-500">+{entry.count - entry.reachedBy.length} more</li>}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Calls.

/**
 * What the changed code calls, which may now be called differently: each
 * package, global or unchanged declaration, and the changed or affected
 * declarations that call it, with how the change gets to them. Coarse: a
 * declaration that uses one that changed counts, whatever flows where.
 */
function CallsPanel({ data, files }: { data: ScannedGraph; files: Array<GraphFile> }) {
  const hrefOf = new Map(files.map(({ file, href }) => [file.path, href]));
  return (
    <section className="mt-2 rounded-md border border-neutral-200 dark:border-neutral-800">
      <header className="border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <h3 className="text-sm font-medium">What may now be called differently</h3>
        <p className="mt-1 text-xs text-neutral-500">
          Each thing the changed code uses, and the declarations that use it whose code changed, or uses code that changed. What reaches one of the
          repository's points first, then what reaches a capability (tagged with what it reaches), then other packages, then this repository's own
          declarations (used by changed code). Coarse: using a name counts, whatever ends up passed to it.
        </p>
      </header>
      {data.calls.length === 0 ? (
        <p className="px-4 py-3 text-xs text-neutral-500">The changed code uses nothing.</p>
      ) : (
        <ul>
          {data.calls.map((group) => {
            const callee = data.declarations[group.callee];
            if (callee === undefined) return null;
            return (
              <li key={group.callee} className="border-b border-neutral-200 px-4 py-3 text-xs last:border-b-0 dark:border-neutral-800">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">{callee.label}</span>
                  {group.reaches.map((target) => (
                    <TargetChip key={target} data={data} target={target} />
                  ))}
                  {callee.path !== "" && <span className="font-mono text-neutral-500">{callee.path}</span>}
                  <span className="text-neutral-500">
                    called by {group.count} {group.count === 1 ? "declaration" : "declarations"} that changed or use what changed
                  </span>
                </div>
                <ul className="mt-1.5 flex flex-col gap-1 pl-3">
                  {group.callers.map((caller) => (
                    <li key={caller.id} className="flex flex-wrap items-baseline gap-x-1.5">
                      <DeclarationChip declaration={data.declarations[caller.id]} href={hrefOf.get(data.declarations[caller.id]?.path ?? "") ?? null} />
                      {caller.through.length > 0 && (
                        <span className="text-neutral-500">
                          ← through <span className="font-mono">{[...caller.through].reverse().map((id) => data.declarations[id]?.label ?? "?").join(" ← ")}</span>
                        </span>
                      )}
                    </li>
                  ))}
                  {group.count > group.callers.length && <li className="text-neutral-500">+{group.count - group.callers.length} more</li>}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const chipStyle: Record<string, string> = {
  changed: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200",
  added: "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/50 dark:text-green-200",
  affected: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-200",
  removed: "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200",
};
const quietChip = "border-neutral-200 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400";

function DeclarationChip({ declaration, href }: { declaration: GraphDeclaration | undefined; href: string | null }) {
  if (declaration === undefined) return null;
  const chip = (
    <span title={`${declaration.path}: ${declaration.status}`} className={`rounded border px-1.5 font-mono text-[11px] ${chipStyle[declaration.status] ?? quietChip}`}>
      {declaration.label}
    </span>
  );
  return (
    <span className="inline-flex items-baseline gap-1">
      {href === null ? chip : <a href={href}>{chip}</a>}
      <span className="font-mono text-[11px] text-neutral-400">{declaration.path}</span>
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
  more: { box: "fill-neutral-50 stroke-neutral-200 [stroke-dasharray:3_3] dark:fill-neutral-900 dark:stroke-neutral-700", text: "fill-neutral-500" },
  external: { box: "fill-violet-50 stroke-violet-300 dark:fill-violet-950 dark:stroke-violet-800", text: "fill-violet-900 dark:fill-violet-200" },
  capability: { box: "fill-neutral-900 stroke-neutral-900 dark:fill-neutral-100 dark:stroke-neutral-100", text: "fill-white font-semibold dark:fill-neutral-900" },
  point: { box: "fill-fuchsia-700 stroke-fuchsia-700 dark:fill-fuchsia-300 dark:stroke-fuchsia-300", text: "fill-white font-semibold dark:fill-fuchsia-950" },
  // A far file, folded (see foldedGraph): click to open.
  folded: { box: "fill-neutral-50 stroke-neutral-400 [stroke-dasharray:4_3] dark:fill-neutral-900 dark:stroke-neutral-600", text: "fill-neutral-700 dark:fill-neutral-300" },
  // A bundle of arrows into or out of a box (see bundledGraph): how many.
  hub: { box: "fill-white stroke-sky-400 dark:fill-neutral-950 dark:stroke-sky-700", text: "fill-sky-800 text-[11px] font-semibold dark:fill-sky-200" },
};
const fallbackNode = { box: "fill-white stroke-neutral-300 dark:fill-neutral-950 dark:stroke-neutral-700", text: "fill-neutral-700 dark:fill-neutral-300" };

/** Each edge kind: its line, and which arrowhead (by color). */
const edgeStyle: Record<string, { line: string; marker: string }> = {
  added: { line: "stroke-green-600", marker: "green" },
  new: { line: "stroke-green-600 [stroke-width:2]", marker: "green" },
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

/** The drawing in a frame that scrolls: the graphs other than Ripple + import map. */
function GraphSvg({ layout, roundedCorners }: { layout: GraphLayout; roundedCorners: boolean }) {
  return (
    <div className="max-h-[75vh] overflow-auto">
      <GraphDrawing layout={layout} roundedCorners={roundedCorners} />
    </div>
  );
}

/**
 * The graph as SVG. `roundedCorners`: the lines are straight runs (ELK's),
 * drawn with small rounded corners; else they're curved through their
 * points (dagre's). A node marked `data-current` (the declaration being
 * read, see GraphCanvas) is drawn heavier; one marked `data-dim` (focus,
 * see GraphCanvas), and a line, faded. A node with `toggle` (a folded
 * file) calls `onToggle` when clicked. With `overview`, zoomed far out
 * (the canvas marks the drawing `data-far`), the declarations' names give
 * way to each file's name and count, kept large on screen.
 */
function GraphDrawing({
  layout,
  roundedCorners,
  overview = false,
  onToggle,
}: {
  layout: GraphLayout;
  roundedCorners: boolean;
  overview?: boolean;
  onToggle?: (toggle: string) => void;
}) {
  const farHidden = overview ? "group-data-[far]/canvas:hidden" : "";
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
            <text x={group.x - group.width / 2 + 6} y={group.y - group.height / 2 - 5} className={`fill-neutral-500 text-[11px] ${farHidden}`}>
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
            strokeWidth={edge.wide === true ? 3.5 : 1.5}
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
            <rect
              x={node.x - node.width / 2}
              y={node.y - node.height / 2}
              width={node.width}
              height={node.height}
              rx={node.kind === "hub" ? node.height / 2 : 4}
              strokeWidth="1.25"
              className={style.box}
            />
            <text x={node.x} y={node.note === null ? node.y + 4 : node.y - 3} textAnchor="middle" className={`${style.text} ${farHidden}`}>
              {shorten(node.label)}
            </text>
            {node.note !== null && (
              <text x={node.x} y={node.y + 12} textAnchor="middle" className={`fill-neutral-500 font-sans text-[10px] ${farHidden}`}>
                {node.note}
              </text>
            )}
          </g>
        );
        const marks = "transition-opacity [&[data-dim]]:opacity-15 [&[data-current]_rect]:stroke-blue-600 [&[data-current]_rect]:[stroke-width:3px]";
        if (node.toggle !== undefined && onToggle !== undefined) {
          const toggle = node.toggle;
          return (
            <g
              key={node.id}
              data-node={node.id}
              role="button"
              tabIndex={0}
              onClick={() => onToggle(toggle)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onToggle(toggle);
              }}
              className={`cursor-pointer [&:hover_rect]:stroke-blue-500 ${marks}`}
            >
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
      {/* Zoomed far out: each file's name and how many it has, as large on screen at any zoom. */}
      {overview &&
        layout.groups.map((group) => {
          const count = layout.nodes.filter((node) => node.group === group.id && node.kind !== "external" && node.kind !== "point").length;
          return (
            <text
              key={`overview:${group.id}`}
              x={group.x}
              y={group.y}
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ fontSize: "calc(13px * var(--inverse-scale, 1))" }}
              className="hidden fill-neutral-800 font-sans font-semibold [paint-order:stroke] stroke-white [stroke-width:calc(3px*var(--inverse-scale,1))] group-data-[far]/canvas:block dark:fill-neutral-100 dark:stroke-neutral-950"
            >
              {group.label.split("/").at(-1)} · {count}
            </text>
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

// ---------------------------------------------------------------------------
// Neighbors.

/**
 * A declaration's header on the Neighbors tab: what it uses that changed on
 * the left, it in the middle, what uses it on the right, anywhere in the
 * repository (another file's are named with their file).
 */
export function MiniGraph({ file, declaration, title }: { file: AnalyzedFile; declaration: AnalyzedDeclaration; title: ReactNode }) {
  const data = useContext(GraphContext);
  const { uses, usedBy } = neighborsOf(file, declaration, data?.status === "scanned" ? data : null);
  return (
    <span className="flex items-center gap-2">
      <span className="flex w-1/4 shrink-0 flex-col items-end gap-1">
        {uses.length === 0 ? (
          <span className="text-neutral-400">uses nothing that changed</span>
        ) : (
          uses.map((use) => (
            <span key={use.name} className={`rounded border px-1.5 font-mono text-[11px] ${chipStyle[use.status] ?? quietChip}`}>
              {use.name}
            </span>
          ))
        )}
      </span>
      <span className="text-neutral-400" aria-hidden>
        →
      </span>
      <span className="min-w-0 shrink rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700">{title}</span>
      <span className="text-neutral-400" aria-hidden>
        →
      </span>
      <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
        {usedBy === null ? (
          <span className="text-neutral-400">finding what uses it…</span>
        ) : usedBy.length === 0 ? (
          <span className="text-neutral-400">nothing uses it</span>
        ) : (
          usedBy.map((user) => (
            <span key={`${user.path}\0${user.label}`} className="inline-flex max-w-full items-baseline gap-1">
              <span className={`rounded border px-1.5 font-mono text-[11px] ${chipStyle[user.status] ?? quietChip}`}>{user.label}</span>
              {user.path !== null && <span className="truncate font-mono text-[11px] text-neutral-400">{user.path}</span>}
            </span>
          ))
        )}
      </span>
    </span>
  );
}
