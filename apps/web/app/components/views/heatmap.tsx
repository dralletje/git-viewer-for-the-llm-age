import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { GraphNote, Swatch } from "#/components/graphs.tsx";
import type { ViewProps } from "#/components/views/views.tsx";
import { headerHeight, heatTree, indexTree, layoutTreemap, type HeatNode, type HeatStatus, type PlacedHeat } from "#/views/heatmap.ts";

type ColorMode = "status" | "distance";

/**
 * Heat map: the code the changes touch as a squarified treemap, package →
 * folder → file → declaration, each declaration as large as its lines.
 * Coloured by what happened to each declaration, or by how many uses away
 * from a change it is. Click a box to zoom into it, a declaration for its
 * code below. Stuck to the top of the code column, as tall as dragged,
 * like the Ripple graph.
 */
export function HeatmapView({ data, files, pageTitle }: ViewProps) {
  const tree = useMemo(() => heatTree(data), [data]);
  const index = useMemo(() => indexTree(tree), [tree]);
  const hrefOf = useMemo(() => new Map(files.map((file) => [file.path, file.href])), [files]);
  const [mode, setMode] = useState<ColorMode>("status");
  const [zoom, setZoom] = useState<string>("root");
  // Another commit's tree may not have the box zoomed into: the whole map again.
  const shown = index.byId.get(zoom) ?? tree;
  const trail: Array<HeatNode> = [];
  for (let id: string | undefined = shown.id; id !== undefined; id = index.parentOf.get(id)) {
    const node = index.byId.get(id);
    if (node !== undefined) trail.unshift(node);
  }
  const maxDistance = Math.max(0, ...[...index.byId.values()].map((node) => node.distance ?? 0));

  // The sticky map's height: dragged at its bottom edge, kept in this
  // browser (the same as the Ripple graph's). 0: the first 45% of the screen.
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
    // 24px: the sticky map covers the code column's padding (-top-6).
    const update = () => column.style.setProperty("--files-top", `${element.offsetHeight - 24}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      column.style.removeProperty("--files-top");
    };
  }, []);

  if (tree.children.length === 0) return <GraphNote>No code of the repository's in the graph: nothing to map.</GraphNote>;

  const legend =
    mode === "status" ? (
      <>
        <Swatch className={`${swatch.changed}`}>changed</Swatch>
        <Swatch className={`${swatch.added}`}>new</Swatch>
        <Swatch className={`${swatch.removed}`}>removed</Swatch>
        <Swatch className={`${swatch.affected}`}>same code, uses what changed</Swatch>
        <Swatch className={`${swatch.unchanged}`}>untouched (the other end of a use that changed)</Swatch>
      </>
    ) : (
      <>
        <span className="inline-flex items-center gap-1">
          {distanceSwatch.map((className, hops) => (
            <span key={hops} title={hops === 0 ? "a change" : `${hops}${hops === distanceSwatch.length - 1 ? " or more" : ""} uses away`} className={`inline-block h-3 w-4 rounded-sm border ${className}`} />
          ))}
          <span className="ml-1">a change → {distanceSwatch.length - 1}+ uses away</span>
        </span>
        <Swatch className={`${swatch.unchanged}`}>not on the ripple</Swatch>
      </>
    );

  return (
    <>
      <header className="py-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">The code the changes touch, by package, folder and file: each declaration as large as its lines</h3>
          <span className="text-[11px] text-neutral-500">Click a box to zoom in, a declaration for its code below.</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
          {legend}
          <Swatch className="border-indigo-300 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950">an app or package (its package.json's folder)</Swatch>
          <span>
            Only what the graph holds: the changes, what uses them, and the other ends of uses that changed; the rest of the repository isn't drawn.
            {data.ripple.affected > data.ripple.shown && ` The nearest ${data.ripple.shown} of ${data.ripple.affected} affected declarations.`}
          </span>
        </div>
      </header>
      <div
        ref={sticky}
        data-sticky-graph
        style={{ height: height > 0 ? `${height}px` : "45vh" }}
        className="sticky -top-6 z-20 -mx-6 flex flex-col border-y border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
      >
        {/* Once the header has scrolled away: what these changes are, where in the map, and the way back up. */}
        <div className="flex h-6 shrink-0 items-center gap-2 border-b border-neutral-100 px-3 text-[11px] text-neutral-500 dark:border-neutral-900">
          <span className="min-w-0 max-w-[40%] shrink truncate">{pageTitle}</span>
          <nav aria-label="Zoomed into" className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {trail.map((node, position) => (
              <span key={node.id} className="flex min-w-0 items-center gap-1">
                {position > 0 && <span className="text-neutral-300 dark:text-neutral-700">/</span>}
                <button
                  type="button"
                  onClick={() => setZoom(node.id)}
                  disabled={position === trail.length - 1}
                  className="truncate rounded px-1 hover:bg-neutral-100 hover:text-neutral-800 disabled:font-medium disabled:text-neutral-800 disabled:hover:bg-transparent dark:hover:bg-neutral-800 dark:hover:text-neutral-200 dark:disabled:text-neutral-200"
                >
                  {node.kind === "root" ? "Everything" : node.label}
                </button>
              </span>
            ))}
          </nav>
          <span className="flex shrink-0 items-center gap-1">
            Colour
            {(["status", "distance"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                aria-pressed={mode === option}
                className={`rounded border px-1.5 leading-4 ${mode === option ? "border-neutral-400 bg-neutral-100 text-neutral-900 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100" : "border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"}`}
              >
                {option === "status" ? "by status" : "by distance from the change"}
              </button>
            ))}
          </span>
          <button
            type="button"
            onClick={() => sticky.current?.parentElement?.scrollTo({ top: 0, behavior: "smooth" })}
            title="Back to the top: the commit, the tabs and the legend"
            className="shrink-0 rounded px-1.5 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            ↑ Top
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          <HeatmapDrawing root={shown} mode={mode} maxDistance={maxDistance} hrefOf={hrefOf} targets={data.targets} onZoom={setZoom} />
        </div>
        <div
          role="separator"
          aria-orientation="horizontal"
          title="Drag to make the map taller or shorter"
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

// ---------------------------------------------------------------------------
// Colours.

/** A declaration's fill by what happened to it, and its name's colour on that fill. */
const statusFill: Record<HeatStatus, { fill: string; text: string }> = {
  changed: { fill: "fill-amber-300 dark:fill-amber-600", text: "fill-amber-950 dark:fill-white" },
  added: { fill: "fill-green-300 dark:fill-green-600", text: "fill-green-950 dark:fill-white" },
  removed: { fill: "fill-red-300 dark:fill-red-600", text: "fill-red-950 dark:fill-white" },
  affected: { fill: "fill-sky-200 dark:fill-sky-800", text: "fill-sky-950 dark:fill-sky-50" },
  unchanged: { fill: "fill-neutral-100 dark:fill-neutral-800", text: "fill-neutral-600 dark:fill-neutral-300" },
};
const swatch: Record<HeatStatus, string> = {
  changed: "border-amber-400 bg-amber-300 dark:border-amber-500 dark:bg-amber-600",
  added: "border-green-400 bg-green-300 dark:border-green-500 dark:bg-green-600",
  removed: "border-red-400 bg-red-300 dark:border-red-500 dark:bg-red-600",
  affected: "border-sky-300 bg-sky-200 dark:border-sky-700 dark:bg-sky-800",
  unchanged: "border-neutral-300 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800",
};
/** The bar in a box's name strip: how much of each, side by side. */
const mixFill: Record<HeatStatus, string> = {
  changed: "fill-amber-400 dark:fill-amber-500",
  added: "fill-green-500",
  removed: "fill-red-500",
  affected: "fill-sky-400 dark:fill-sky-600",
  unchanged: "fill-neutral-300 dark:fill-neutral-600",
};

/**
 * By distance: one hue, darkest (light mode) or brightest (dark mode) at
 * the change and fading with each use away, so the eye finds the change
 * first. The last step is "this far or further".
 */
const distanceFill: Array<{ fill: string; text: string }> = [
  { fill: "fill-orange-600 dark:fill-orange-400", text: "fill-white dark:fill-orange-950" },
  { fill: "fill-orange-500 dark:fill-orange-500", text: "fill-orange-950" },
  { fill: "fill-orange-400 dark:fill-orange-600", text: "fill-orange-950 dark:fill-orange-50" },
  { fill: "fill-orange-300 dark:fill-orange-700", text: "fill-orange-950 dark:fill-orange-50" },
  { fill: "fill-orange-200 dark:fill-orange-800", text: "fill-orange-950 dark:fill-orange-100" },
  { fill: "fill-orange-100 dark:fill-orange-950", text: "fill-orange-900 dark:fill-orange-200" },
];
const distanceSwatch = [
  "border-orange-700 bg-orange-600 dark:border-orange-300 dark:bg-orange-400",
  "border-orange-600 bg-orange-500 dark:border-orange-400 dark:bg-orange-500",
  "border-orange-500 bg-orange-400 dark:border-orange-500 dark:bg-orange-600",
  "border-orange-400 bg-orange-300 dark:border-orange-600 dark:bg-orange-700",
  "border-orange-300 bg-orange-200 dark:border-orange-700 dark:bg-orange-800",
  "border-orange-200 bg-orange-100 dark:border-orange-800 dark:bg-orange-950",
];

function leafColour(node: HeatNode, mode: ColorMode): { fill: string; text: string } {
  if (mode === "status") return statusFill[node.status ?? "unchanged"];
  if (node.distance === null) return statusFill.unchanged;
  return distanceFill[Math.min(node.distance, distanceFill.length - 1)] ?? statusFill.unchanged;
}

const statusWord: Record<HeatStatus, string> = {
  changed: "changed",
  added: "new",
  removed: "removed",
  affected: "same code, uses what changed",
  unchanged: "untouched",
};

// ---------------------------------------------------------------------------
// The map, drawn.

/** About how wide a character is, to cut a name to what fits. */
const charWidth = { box: 6.2, leaf: 6 };

function fit(label: string, width: number, perChar: number): string | null {
  const room = Math.floor(width / perChar);
  if (room < 3) return null;
  return label.length <= room ? label : `${label.slice(0, room - 1)}…`;
}

/**
 * The treemap of `root`'s contents, as wide and tall as its frame (it
 * follows the column's width and the dragged height). Hover: what a box
 * or declaration is. The declaration being read in the code below
 * ("room:reading", see ChangesView) is outlined.
 */
function HeatmapDrawing({
  root,
  mode,
  maxDistance,
  hrefOf,
  targets,
  onZoom,
}: {
  root: HeatNode;
  mode: ColorMode;
  maxDistance: number;
  hrefOf: Map<string, string>;
  targets: Record<string, { label: string }>;
  onZoom: (id: string) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const placed = useMemo(() => (size === null ? [] : layoutTreemap(root, { x: 0, y: 0, width: size.width, height: size.height })), [root, size?.width, size?.height]);

  const [hover, setHover] = useState<{ node: HeatNode; x: number; y: number } | null>(null);
  // Zoomed in or out: what was under the pointer may not be drawn any more.
  useEffect(() => setHover(null), [root]);
  const [reading, setReading] = useState<string | null>(null);
  useEffect(() => {
    const onReading = (event: Event) => setReading((event as CustomEvent<{ id: string | null }>).detail.id);
    window.addEventListener("room:reading", onReading);
    return () => window.removeEventListener("room:reading", onReading);
  }, []);

  const leafHref = (node: HeatNode) => {
    const fileHref = hrefOf.get(node.path);
    return fileHref === undefined ? null : `${fileHref}--${encodeURIComponent(node.label)}`;
  };

  const hovered = (event: MouseEvent, node: HeatNode) => {
    const bounds = frame.current?.getBoundingClientRect();
    if (bounds === undefined) return;
    setHover({ node, x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  };

  return (
    <div ref={frame} className="absolute inset-0 overflow-hidden" onMouseLeave={() => setHover(null)}>
      {size !== null && (
        <svg width={size.width} height={size.height} className="block font-sans" role="img" aria-label="Heat map">
          {placed.map((entry) =>
            entry.node.kind === "declaration" ? (
              <Leaf
                key={entry.node.id}
                entry={entry}
                mode={mode}
                href={leafHref(entry.node)}
                currentId={reading}
                onHover={hovered}
              />
            ) : (
              <Box key={entry.node.id} entry={entry} mix={mode === "status"} onZoom={onZoom} onHover={hovered} />
            ),
          )}
        </svg>
      )}
      {hover !== null && size !== null && <Tooltip hover={hover} size={size} maxDistance={maxDistance} targets={targets} />}
    </div>
  );
}

function Box({ entry, mix, onZoom, onHover }: { entry: PlacedHeat; mix: boolean; onZoom: (id: string) => void; onHover: (event: MouseEvent, node: HeatNode) => void }) {
  const { node } = entry;
  const style =
    node.kind === "package"
      ? { box: "fill-indigo-50/60 stroke-indigo-300 dark:fill-indigo-950/40 dark:stroke-indigo-800", text: "fill-indigo-900 font-semibold dark:fill-indigo-200" }
      : node.kind === "folder"
        ? { box: "fill-neutral-50 stroke-neutral-300 dark:fill-neutral-900 dark:stroke-neutral-700", text: "fill-neutral-700 dark:fill-neutral-300" }
        : { box: "fill-white stroke-neutral-300 dark:fill-neutral-950 dark:stroke-neutral-700", text: "fill-neutral-500 font-mono dark:fill-neutral-400" };
  // The mix of statuses (only beside the status colours) takes the strip's right end when there's room beside the name.
  const barWidth = mix && entry.header && entry.width >= 120 ? Math.min(60, entry.width / 4) : 0;
  const label = entry.header ? fit(node.label, entry.width - 8 - (barWidth > 0 ? barWidth + 6 : 0), charWidth.box) : null;
  const total = Object.values(node.counts).reduce((sum, count) => sum + count, 0);
  let offset = 0;
  return (
    <g
      onClick={() => onZoom(node.id)}
      onMouseMove={(event) => onHover(event, node)}
      className="cursor-zoom-in [&:hover>rect:first-child]:stroke-blue-500"
    >
      <rect x={entry.x + 0.5} y={entry.y + 0.5} width={Math.max(0, entry.width - 1)} height={Math.max(0, entry.height - 1)} rx={node.kind === "package" ? 4 : 2} className={style.box} />
      {label !== null && (
        <text x={entry.x + 5} y={entry.y + headerHeight - 4.5} className={`text-[11px] ${style.text}`}>
          {label}
        </text>
      )}
      {barWidth > 0 &&
        (Object.keys(node.counts) as Array<HeatStatus>).map((status) => {
          const count = node.counts[status];
          if (count === 0 || total === 0) return null;
          const width = (count / total) * barWidth;
          const x = entry.x + entry.width - 4 - barWidth + offset;
          offset += width;
          return <rect key={status} x={x} y={entry.y + 6} width={width} height={5} className={mixFill[status]} />;
        })}
    </g>
  );
}

function Leaf({
  entry,
  mode,
  href,
  currentId,
  onHover,
}: {
  entry: PlacedHeat;
  mode: ColorMode;
  href: string | null;
  currentId: string | null;
  onHover: (event: MouseEvent, node: HeatNode) => void;
}) {
  const { node } = entry;
  const colour = leafColour(node, mode);
  // The declaration being read below: compared as the page names it ("file-3--name").
  const isCurrent = currentId !== null && href !== null && decodeURIComponent(href.slice(1)) === currentId;
  const label = entry.width >= 24 && entry.height >= 13 ? fit(node.label, entry.width - 6, charWidth.leaf) : null;
  const shape = (
    <>
      <rect
        x={entry.x}
        y={entry.y}
        width={entry.width}
        height={entry.height}
        strokeWidth={isCurrent ? 2.5 : 1}
        className={`${colour.fill} ${isCurrent ? "stroke-blue-600 dark:stroke-blue-400" : "stroke-white dark:stroke-neutral-950"}`}
      />
      {label !== null && (
        <text x={entry.x + 3} y={entry.y + 11} className={`pointer-events-none font-mono text-[10px] ${colour.text} ${node.status === "removed" ? "line-through" : ""}`}>
          {label}
        </text>
      )}
    </>
  );
  return href === null ? (
    <g onMouseMove={(event) => onHover(event, node)}>{shape}</g>
  ) : (
    <a href={href} onMouseMove={(event) => onHover(event, node)} className="cursor-pointer [&:hover>rect]:stroke-blue-500 [&:hover>rect]:[stroke-width:2px]">
      {shape}
    </a>
  );
}

/** What's under the pointer: where it is, what happened to it, how far from a change, and what it reaches. */
function Tooltip({
  hover,
  size,
  maxDistance,
  targets,
}: {
  hover: { node: HeatNode; x: number; y: number };
  size: { width: number; height: number };
  maxDistance: number;
  targets: Record<string, { label: string }>;
}) {
  const { node } = hover;
  const kind = node.kind === "package" ? "App or package" : node.kind === "folder" ? "Folder" : node.kind === "file" ? "File" : "Declaration";
  const distance =
    node.distance === null
      ? "not on the ripple"
      : node.distance === 0
        ? node.kind === "declaration"
          ? "it's a change"
          : "holds a change"
        : `${node.distance} ${node.distance === 1 ? "use" : "uses"} from a change${node.kind === "declaration" ? "" : " at nearest"}${maxDistance > 0 ? ` (furthest in the map: ${maxDistance})` : ""}`;
  const counts = (Object.keys(node.counts) as Array<HeatStatus>).filter((status) => node.counts[status] > 0).map((status) => `${node.counts[status]} ${statusWord[status]}`);
  const points = node.points.map((key) => targets[key]?.label ?? key);
  const rows: Array<[string, ReactNode]> = [
    ["Status", node.status !== null ? statusWord[node.status] : counts.join(" · ")],
    ["Lines", String(node.size)],
    ["Distance", distance],
    ["Reaches", points.length === 0 ? "no points" : points.join(", ")],
  ];
  // Beside the pointer, flipped to the other side near the frame's edges.
  const left = hover.x + 300 > size.width ? Math.max(4, hover.x - 290) : hover.x + 14;
  const top = hover.y + 110 > size.height ? Math.max(4, hover.y - 104) : hover.y + 14;
  return (
    <div
      style={{ left, top }}
      className="pointer-events-none absolute z-30 w-[280px] rounded-md border border-neutral-200 bg-white/95 px-2.5 py-1.5 text-[11px] text-neutral-700 shadow-md dark:border-neutral-700 dark:bg-neutral-900/95 dark:text-neutral-200"
    >
      <div className="font-medium">
        {kind}: <span className="font-mono">{node.label}</span>
      </div>
      <div className="truncate font-mono text-neutral-500">{node.path === "" ? "(the repository's root)" : node.path}</div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-neutral-500">{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
