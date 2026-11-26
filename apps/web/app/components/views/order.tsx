import { useEffect, useMemo, useRef, useState } from "react";
import { GraphNote, Swatch } from "#/components/graphs.tsx";
import type { ViewProps } from "#/components/views/views.tsx";
import { readingOrder } from "#/views/order.ts";

const chip: Record<string, { className: string; word: string }> = {
  changed: { className: "border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200", word: "changed" },
  added: { className: "border-green-400 bg-green-50 text-green-900 dark:border-green-700 dark:bg-green-950 dark:text-green-200", word: "new" },
  affected: { className: "border-sky-400 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-200", word: "same code" },
  unchanged: { className: "border-neutral-300 bg-white text-neutral-600 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-400", word: "unchanged" },
};

/**
 * The declaration graph as a list to read from top to bottom: each
 * declaration after what it uses, so by the time a reader gets to one,
 * what it builds on is already read. Stuck to the top of the code (as the
 * Ripple graph is, see GraphFrame), it follows the reading: the declaration
 * scrolled to is marked, and Next / Previous (or j / k) go along the list.
 */
export function OrderView({ data, files, pageTitle }: ViewProps) {
  const rows = useMemo(() => {
    const hrefOf = new Map(files.map(({ path, href }) => [path, href]));
    return readingOrder(data).map((row) => {
      // The declaration itself on the page (see nodeOf in graphs.ts); the page falls back to its file.
      const fileHref = hrefOf.get(row.declaration.path);
      const href = fileHref === undefined ? null : `${fileHref}--${encodeURIComponent(row.declaration.label)}`;
      return { ...row, href, anchor: href === null ? null : decodeURIComponent(href.slice(1)) };
    });
  }, [data, files]);
  const left = Object.values(data.declarations).filter((declaration) => declaration.status === "removed").length;

  // The row being read in the code below (ChangesView's "room:reading"), and
  // every row that has been: the progress line counts those.
  const [reading, setReading] = useState<number | null>(null);
  const [read, setRead] = useState<ReadonlySet<string>>(() => new Set());
  // Where Next and Previous go from: the row jumped to last, or read last.
  const cursor = useRef<number | null>(null);
  // Right after a jump, the code settles under the line that says what's
  // being read; a short declaration can put its neighbour there. Next
  // still goes on from the one jumped to.
  const jumpedAt = useRef(0);

  useEffect(() => {
    const byAnchor = new Map(rows.flatMap((row, index) => (row.anchor === null ? [] : [[row.anchor, index] as const])));
    const onReading = (event: Event) => {
      const id = (event as CustomEvent<{ id: string | null }>).detail.id;
      const index = id === null ? undefined : byAnchor.get(id);
      setReading(index ?? null);
      if (index === undefined) return;
      if (performance.now() - jumpedAt.current > 600) cursor.current = index;
      setRead((before) => (before.has(id ?? "") ? before : new Set([...before, id ?? ""])));
    };
    window.addEventListener("room:reading", onReading);
    return () => window.removeEventListener("room:reading", onReading);
  }, [rows]);

  /** To a row's code: through the address, as any link on the page (ChangesView jumps on hashchange). */
  const go = (index: number) => {
    const row = rows[index];
    if (row === undefined || row.href === null) return;
    cursor.current = index;
    jumpedAt.current = performance.now();
    // The marker moves at once, also when the code is already there and doesn't scroll.
    setReading(index);
    if (window.location.hash === row.href) window.dispatchEvent(new HashChangeEvent("hashchange"));
    else window.location.hash = row.href;
  };
  const step = (by: 1 | -1) => {
    const from = cursor.current;
    go(from === null ? (by === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, from + by)));
  };

  // j / k as Next / Previous, unless typing.
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select") !== null)) return;
      if (event.key === "j") stepRef.current(1);
      else if (event.key === "k") stepRef.current(-1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The row being read stays in sight in the list, by scrolling only the list.
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const box = list.current;
    const row = reading === null ? null : box?.querySelector(`[data-row="${reading}"]`);
    if (box === null || box === undefined || row === null || row === undefined) return;
    const rowBox = row.getBoundingClientRect();
    const listBox = box.getBoundingClientRect();
    if (rowBox.top < listBox.top + 4) box.scrollTop -= listBox.top + 4 - rowBox.top + rowBox.height;
    else if (rowBox.bottom > listBox.bottom - 4) box.scrollTop += rowBox.bottom - listBox.bottom + 4 + rowBox.height;
  }, [reading]);

  // The list's height: dragged at its bottom edge, kept in this browser
  // (its own, not the graphs'). 0: the first 35% of the screen.
  const sticky = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(() => {
    try {
      return Number(localStorage.getItem("room:order-height")) || 0;
    } catch {
      return 0;
    }
  });
  const resizing = useRef<{ startY: number; startHeight: number } | null>(null);
  // The files' headers stick right below it, and a jump puts a file there (as GraphFrame does).
  useEffect(() => {
    const element = sticky.current;
    const column = element?.parentElement;
    if (element === null || element === undefined || column === null || column === undefined) return;
    // 24px: the sticky list covers the code column's padding (-top-6).
    const update = () => column.style.setProperty("--files-top", `${element.offsetHeight - 24}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      column.style.removeProperty("--files-top");
    };
  }, []);

  if (rows.length === 0) return <GraphNote>No code that runs changed: nothing to read in order.</GraphNote>;
  const readCount = rows.filter((row) => row.anchor !== null && read.has(row.anchor)).length;
  const buttonClass =
    "shrink-0 rounded border border-neutral-300 px-1.5 hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200";

  return (
    <>
      <header className="py-2">
        <h3 className="text-sm font-medium">The changes in the order to read them: each declaration after what it uses</h3>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
          <Swatch className="border-amber-400 bg-amber-50 dark:bg-amber-950">changed</Swatch>
          <Swatch className="border-green-400 bg-green-50 dark:bg-green-950">new</Swatch>
          <Swatch className="border-sky-400 bg-sky-50 dark:bg-sky-950">same code, uses what changed</Swatch>
          <span>Indented by how many uses away from a change.</span>
          <span>↻: in a cycle, it uses one further down.</span>
          <span>Next / Previous, or j / k, go along the list.</span>
          {data.ripple.affected > data.ripple.shown && <span>The nearest {data.ripple.shown} of {data.ripple.affected} affected declarations.</span>}
          {left > 0 && <span>{left} removed {left === 1 ? "declaration isn't" : "declarations aren't"} listed: nothing of them runs any more.</span>}
        </div>
      </header>
      <div
        ref={sticky}
        // ChangesView looks for this to say which declaration is being read.
        data-sticky-graph
        style={{ height: height > 0 ? `${height}px` : "35vh" }}
        className="sticky -top-6 z-20 -mx-6 flex flex-col border-y border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950"
      >
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-neutral-100 px-3 text-[11px] text-neutral-500 dark:border-neutral-900">
          <span className="min-w-0 flex-1 truncate">{pageTitle}</span>
          <span className="shrink-0 tabular-nums" title="Declarations that have been the one being read in the code, at least once">
            {readCount} of {rows.length} read
          </span>
          <button type="button" onClick={() => step(-1)} title="The one before (k)" className={buttonClass}>
            ↑ Previous
          </button>
          <button type="button" onClick={() => step(1)} title="The next one to read (j)" className={buttonClass}>
            ↓ Next
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
        <ol ref={list} className="min-h-0 flex-1 overflow-y-auto py-1 font-mono text-xs">
          {rows.map((row, index) => {
            const style = chip[row.declaration.status] ?? chip.unchanged;
            const current = index === reading;
            const seen = row.anchor !== null && read.has(row.anchor);
            const content = (
              <>
                <span className="w-8 shrink-0 text-right tabular-nums text-neutral-400">{index + 1}</span>
                <span className="shrink-0" style={{ width: `${Math.min(row.depth, 8) * 14}px` }} />
                <span className={`shrink-0 rounded border px-1 font-sans text-[10px] ${style?.className ?? ""}`}>{style?.word}</span>
                <span className={`truncate font-semibold ${seen && !current ? "text-neutral-500" : ""}`}>{row.declaration.label}</span>
                {row.usesLater && (
                  <span className="shrink-0 text-amber-600 dark:text-amber-400" title="In a cycle: it uses a declaration further down the list">
                    ↻
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-right text-[11px] text-neutral-400" title={row.declaration.path}>
                  {row.declaration.path}
                </span>
              </>
            );
            const className = `flex items-center gap-2 border-l-[3px] py-0.5 pl-2 pr-3 ${current ? "border-blue-600 bg-blue-50 dark:border-blue-400 dark:bg-blue-950" : "border-transparent"}`;
            return (
              <li key={row.declaration.id} data-row={index}>
                {row.href === null ? (
                  <span className={className}>{content}</span>
                ) : (
                  <a
                    href={row.href}
                    onClick={(event) => {
                      // Through `go`: the cursor moves too, and a link to where the address already is still jumps.
                      event.preventDefault();
                      go(index);
                    }}
                    className={`${className} hover:bg-neutral-50 dark:hover:bg-neutral-900`}
                  >
                    {content}
                  </a>
                )}
              </li>
            );
          })}
        </ol>
        <div
          role="separator"
          aria-orientation="horizontal"
          title="Drag to make the list taller or shorter"
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
              localStorage.setItem("room:order-height", String(sticky.current?.offsetHeight ?? 0));
            } catch {
              // Not kept: the next page starts at 35% again.
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
