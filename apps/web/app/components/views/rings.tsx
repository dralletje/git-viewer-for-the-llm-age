import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { attachCanvas, type Canvas } from "@room/canvas";
import { Swatch } from "#/components/graphs.tsx";
import type { ViewProps } from "#/components/views/views.tsx";
import { pathsThrough, ringsLayout, shortLabel, type RingNode, type RingsLayout } from "#/views/rings.ts";

/**
 * Distance rings: the ripple drawn as ripples. The changed declarations in
 * the middle, and around them a ring for each step out along the uses: what
 * uses a change directly on the first ring, what uses those on the second,
 * and so on. How far out a declaration sits is how far a change had to
 * travel to reach it.
 */
export function RingsView({ data, files, pageTitle }: ViewProps) {
  const layout = useMemo(() => ringsLayout(data), [data]);
  const hrefOf = useMemo(() => new Map(files.map(({ path, href }) => [path, href])), [files]);
  const farthest = layout.rings.length - 1;

  const legend = (
    <>
      <Swatch className="border-amber-400 bg-amber-50 dark:bg-amber-950">changed</Swatch>
      <Swatch className="border-green-400 bg-green-50 dark:bg-green-950">new</Swatch>
      <Swatch className="border-sky-400 bg-sky-50 dark:bg-sky-950">same code, uses what changed</Swatch>
      <span className="inline-flex items-center gap-1">
        <svg width="12" height="12" aria-hidden className="shrink-0">
          <circle cx="6" cy="6" r="4" className="fill-fuchsia-600 stroke-white dark:fill-fuchsia-400 dark:stroke-neutral-950" strokeWidth="1.5" />
        </svg>
        reaches one of the repository's points (hover: which)
      </span>
      <span className="inline-flex items-center gap-1">
        <svg width="22" height="8" aria-hidden className="shrink-0">
          <line x1="1" y1="4" x2="21" y2="4" strokeWidth="2" className="stroke-amber-500" />
        </svg>
        the way in to a change
      </span>
      <span className="inline-flex items-center gap-1">
        <svg width="22" height="8" aria-hidden className="shrink-0">
          <line x1="1" y1="4" x2="21" y2="4" strokeWidth="2" className="stroke-sky-500" />
        </svg>
        on out to what it reaches
      </span>
      <span>
        In the middle what changed; each ring one step further along the uses: the first ring uses a change, the second uses the first, and so on. A declaration sits on its shortest way out.
        {data.ripple.affected > data.ripple.shown && ` The nearest ${data.ripple.shown} of ${data.ripple.affected} affected declarations.`}
        {layout.unreached > 0 && ` ${layout.unreached} the ripple names aren't reached from a change and aren't drawn.`}
      </span>
      <span>Hover a declaration for its ways in and out; click it to keep them, and to go to its code.</span>
    </>
  );

  return (
    <StickyFrame
      title={farthest <= 0 ? "What changed: nothing uses it" : `What changed, and how far it spreads: ${farthest} ${farthest === 1 ? "step" : "steps"} out`}
      legend={legend}
      barTitle={pageTitle}
    >
      {layout.nodes.length === 0 ? <p className="px-4 py-3 text-xs text-neutral-500">No code that runs changed.</p> : <RingsCanvas layout={layout} hrefOf={hrefOf} />}
    </StickyFrame>
  );
}

/**
 * Copied from GraphFrame (graphs.tsx, not exported there): the header
 * scrolls away, the drawing sticks to the top of the code column, as tall as
 * dragged at its bottom edge (kept in this browser, shared with Ripple's).
 */
function StickyFrame({ title, legend, barTitle, children }: { title: string; legend: ReactNode; barTitle: string; children: ReactNode }) {
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
    // 24px: the sticky drawing covers the code column's padding (-top-6).
    const update = () => column.style.setProperty("--files-top", `${element.offsetHeight - 24}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      column.style.removeProperty("--files-top");
    };
  }, []);

  return (
    <>
      <header className="py-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">{title}</h3>
          <span className="text-[11px] text-neutral-500">Drag or scroll to move, pinch or ctrl + scroll to zoom. Click a declaration: its code below.</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">{legend}</div>
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
        <div className="relative min-h-0 flex-1">{children}</div>
        <div
          role="separator"
          aria-orientation="horizontal"
          title="Drag to make the drawing taller or shorter"
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

/** The link to a declaration's code: its file on the page, then its name (as the Ripple's nodes link). */
function hrefOfNode(node: RingNode, hrefOf: Map<string, string>): string | null {
  const fileHref = hrefOf.get(node.path);
  return fileHref === undefined ? null : `${fileHref}--${encodeURIComponent(node.label)}`;
}

/**
 * The rings on a pan/zoom canvas, fitted at first. Pointing at a declaration
 * lights its ways in to the changes and on out, the rest fades; a click keeps
 * that (the background lets go) and goes to its code. The declaration being
 * read below (ChangesView's "room:reading") is marked and moved into sight,
 * as on Ripple.
 */
function RingsCanvas({ layout, hrefOf }: { layout: RingsLayout; hrefOf: Map<string, string> }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const canvas = useRef<Canvas | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);

  useEffect(() => {
    const frame = viewport.current;
    const drawing = content.current;
    if (frame === null || drawing === null) return;
    const attached = attachCanvas(frame, drawing, { size: { width: layout.size, height: layout.size }, minScale: 0.03, maxScale: 3 });
    // All the rings at first, never larger than drawn.
    attached.fit({ maxScale: 1 });
    canvas.current = attached;
    return () => {
      attached.destroy();
      canvas.current = null;
    };
  }, [layout]);

  const hrefs = useMemo(() => new Map(layout.nodes.map((node) => [node.id, hrefOfNode(node, hrefOf)])), [layout, hrefOf]);

  // A kept focus tells the page which files its ways go through (see ChangesView's "room:focus"); the others are hidden below.
  useEffect(() => {
    const tell = (files: Array<string> | null) => window.dispatchEvent(new CustomEvent("room:focus", { detail: { files } }));
    if (pinned === null) {
      tell(null);
      return;
    }
    const lit = pathsThrough(pinned, layout.edges, layout.ring);
    const onPage = new Set<string>();
    for (const id of lit.nodes) {
      const href = hrefs.get(id);
      if (href !== null && href !== undefined) onPage.add(decodeURIComponent(href.slice(1)).split("--")[0] ?? "");
    }
    tell([...onPage]);
  }, [pinned, layout, hrefs]);
  useEffect(() => {
    const clear = () => setPinned(null);
    window.addEventListener("room:focus-clear", clear);
    return () => {
      window.removeEventListener("room:focus-clear", clear);
      // Another tab: the page shows every file again.
      window.dispatchEvent(new CustomEvent("room:focus", { detail: { files: null } }));
    };
  }, []);

  // The declaration being read in the code: marked, and in sight.
  useEffect(() => {
    const onReading = (event: Event) => {
      const id = (event as CustomEvent<{ id: string | null }>).detail.id;
      const node = id === null ? undefined : layout.nodes.find((candidate) => {
        const href = hrefs.get(candidate.id);
        return href !== null && href !== undefined && decodeURIComponent(href.slice(1)) === id;
      });
      setReading(node?.id ?? null);
      const attached = canvas.current;
      const frame = viewport.current;
      if (node === undefined || attached === null || frame === null) return;
      const middle = node.radius + node.length / 2;
      const x = layout.center + Math.cos(node.angle) * (node.radius === 0 ? 0 : middle);
      const y = layout.center + Math.sin(node.angle) * (node.radius === 0 ? 0 : middle);
      // Zoomed out too far to read (a big ripple, fitted): zoom in on it.
      if (attached.view().scale < 0.5) {
        const scale = 0.8;
        attached.setView({ x: frame.clientWidth / 2 - x * scale, y: frame.clientHeight / 2 - y * scale, scale }, { animate: true });
        return;
      }
      attached.show({ x: x - node.length / 2, y: y - node.length / 2, width: node.length, height: node.length }, { animate: true, margin: 40 });
    };
    window.addEventListener("room:reading", onReading);
    return () => window.removeEventListener("room:reading", onReading);
  }, [layout, hrefs]);

  const active = hovered ?? pinned;
  const lit = useMemo(() => (active === null ? null : pathsThrough(active, layout.edges, layout.ring)), [active, layout]);
  const activeRing = active === null ? 0 : (layout.ring.get(active) ?? 0);

  return (
    <div
      ref={viewport}
      className="relative h-full w-full cursor-grab select-none"
      onClick={(event) => {
        // Zoom and Fit keep the focus; the background lets go of it.
        if (event.target instanceof Element && event.target.closest("button") !== null) return;
        if (event.target instanceof Element && event.target.closest("[data-node]") !== null) return;
        setPinned(null);
      }}
    >
      <div ref={content} className="absolute left-0 top-0">
        <svg width={layout.size} height={layout.size} className="block font-mono text-[12px]" role="img" aria-label="Distance rings">
          {layout.rings.map((ring) =>
            ring.radius === 0 ? null : (
              <circle key={ring.ring} cx={layout.center} cy={layout.center} r={ring.radius} fill="none" strokeDasharray="3 5" className="stroke-neutral-300 dark:stroke-neutral-700" />
            ),
          )}
          {layout.edges.map((edge, index) => {
            const on = lit?.edges.has(index) === true;
            // In towards the changes amber, out from the one pointed at sky.
            const inward = (layout.ring.get(edge.to) ?? 0) <= activeRing;
            return (
              <path
                key={index}
                d={edge.d}
                fill="none"
                strokeWidth={on ? 2 : 1}
                className={
                  lit === null
                    ? "stroke-neutral-400 opacity-30 dark:stroke-neutral-500"
                    : on
                      ? inward
                        ? "stroke-amber-500"
                        : "stroke-sky-500"
                      : "stroke-neutral-400 opacity-[0.06] dark:stroke-neutral-500"
                }
              />
            );
          })}
          {layout.rings.map((ring) => (
            <text
              key={ring.ring}
              x={layout.center}
              y={ring.radius === 0 ? layout.center - 18 : layout.center - ring.radius - 6}
              textAnchor="middle"
              className="fill-neutral-500 font-sans text-[12px] font-semibold dark:fill-neutral-400"
            >
              {ring.ring === 0 ? `what changed · ${ring.count}` : `${ring.ring} ${ring.ring === 1 ? "step" : "steps"} · ${ring.count}`}
            </text>
          ))}
          {layout.nodes.map((node) => (
            <RingPill
              key={node.id}
              node={node}
              center={layout.center}
              href={hrefs.get(node.id) ?? null}
              faded={lit !== null && !lit.nodes.has(node.id)}
              current={node.id === reading}
              chosen={node.id === active}
              onHover={(on) => setHovered(on ? node.id : null)}
              onChoose={() => setPinned(node.id)}
            />
          ))}
        </svg>
      </div>
      <div className="absolute bottom-2 right-2 flex gap-1 text-xs">
        <button type="button" onClick={() => canvas.current?.zoomBy(1.25)} title="Zoom in" className={canvasButton}>
          +
        </button>
        <button type="button" onClick={() => canvas.current?.zoomBy(0.8)} title="Zoom out" className={canvasButton}>
          −
        </button>
        <button type="button" onClick={() => canvas.current?.fit({ maxScale: 1, animate: true })} title="All the rings" className={canvasButton}>
          Fit
        </button>
      </div>
    </div>
  );
}

const canvasButton =
  "min-w-7 rounded border border-neutral-300 bg-white/90 px-1.5 py-0.5 text-neutral-700 shadow-sm hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900/90 dark:text-neutral-200 dark:hover:bg-neutral-800";

/** As Ripple colours its declarations (graphs.tsx's nodeStyle, not exported there). */
const pillStyle: Record<string, { box: string; text: string }> = {
  changed: { box: "fill-amber-50 stroke-amber-400 dark:fill-amber-950 dark:stroke-amber-700", text: "fill-amber-950 dark:fill-amber-100" },
  added: { box: "fill-green-50 stroke-green-400 dark:fill-green-950 dark:stroke-green-700", text: "fill-green-950 dark:fill-green-100" },
  removed: { box: "fill-red-50 stroke-red-400 dark:fill-red-950 dark:stroke-red-700", text: "fill-red-900 line-through dark:fill-red-200" },
  affected: { box: "fill-sky-50 stroke-sky-400 dark:fill-sky-950 dark:stroke-sky-700", text: "fill-sky-950 dark:fill-sky-100" },
};
const fallbackPill = { box: "fill-white stroke-neutral-300 dark:fill-neutral-950 dark:stroke-neutral-700", text: "fill-neutral-700 dark:fill-neutral-300" };

/**
 * One declaration: a pill pointing out from the middle, starting on its
 * ring. On the left half its name is turned round, so none reads upside
 * down. The one in the middle lies flat.
 */
function RingPill({
  node,
  center,
  href,
  faded,
  current,
  chosen,
  onHover,
  onChoose,
}: {
  node: RingNode;
  center: number;
  href: string | null;
  faded: boolean;
  current: boolean;
  chosen: boolean;
  onHover: (on: boolean) => void;
  onChoose: () => void;
}) {
  const style = pillStyle[node.status] ?? fallbackPill;
  const flat = node.radius === 0;
  const degrees = flat ? 0 : (node.angle * 180) / Math.PI;
  const start = flat ? -node.length / 2 : node.radius;
  const middle = start + node.length / 2;
  const turned = !flat && Math.cos(node.angle) < 0;
  const title = `${node.label} in ${node.path}: ${node.ring === 0 ? node.status : `${node.ring} ${node.ring === 1 ? "step" : "steps"} from a change`}${node.points.length > 0 ? `. Reaches ${node.points.join(", ")}` : ""}`;
  const body = (
    <g transform={`translate(${center} ${center}) rotate(${degrees})`}>
      <title>{title}</title>
      <rect
        x={start}
        y={-8}
        width={node.length}
        height={16}
        rx="8"
        strokeWidth={current || chosen ? 2.5 : 1.25}
        className={`${style.box} ${current ? "stroke-blue-600!" : chosen ? "stroke-neutral-800! dark:stroke-neutral-100!" : ""}`}
      />
      <text x={middle} y={4} textAnchor="middle" transform={turned ? `rotate(180 ${middle} 0)` : undefined} className={style.text}>
        {shortLabel(node.label)}
      </text>
      {node.points.length > 0 && (
        <circle cx={start + node.length + 7} cy={0} r={4.5} strokeWidth="1.5" className="fill-fuchsia-600 stroke-white dark:fill-fuchsia-400 dark:stroke-neutral-950" />
      )}
    </g>
  );
  const shared = {
    "data-node": node.id,
    onPointerEnter: () => onHover(true),
    onPointerLeave: () => onHover(false),
    onClick: onChoose,
    className: `transition-opacity ${faded ? "opacity-15" : ""} ${href === null ? "" : "cursor-pointer [&:hover_rect]:stroke-blue-500"}`,
  };
  return href === null ? <g {...shared}>{body}</g> : <a href={href} {...shared}>{body}</a>;
}
