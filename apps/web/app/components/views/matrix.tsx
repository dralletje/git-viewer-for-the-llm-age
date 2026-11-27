import { Fragment, useMemo, useState } from "react";
import { GraphNote, Swatch } from "#/components/graphs.tsx";
import type { ViewProps } from "#/components/views/views.tsx";
import type { GraphDeclaration } from "#/graph.server.ts";
import { changeMatrix, shadeOf, type Granularity, type MatrixColumn, type MatrixRow } from "#/views/matrix.ts";

/** A cell's background for its shade (see shadeOf), lightest to darkest: written out so Tailwind finds them. */
const areaShades = [
  "",
  "bg-sky-100 text-sky-950 dark:bg-sky-950 dark:text-sky-100",
  "bg-sky-200 text-sky-950 dark:bg-sky-900 dark:text-sky-100",
  "bg-sky-300 text-sky-950 dark:bg-sky-800 dark:text-sky-50",
  "bg-sky-500 text-white dark:bg-sky-600 dark:text-white",
  "bg-sky-700 text-white dark:bg-sky-400 dark:text-sky-950",
];
const pointShades = [
  "",
  "bg-fuchsia-100 text-fuchsia-950 dark:bg-fuchsia-950 dark:text-fuchsia-100",
  "bg-fuchsia-200 text-fuchsia-950 dark:bg-fuchsia-900 dark:text-fuchsia-100",
  "bg-fuchsia-300 text-fuchsia-950 dark:bg-fuchsia-800 dark:text-fuchsia-50",
  "bg-fuchsia-500 text-white dark:bg-fuchsia-600 dark:text-white",
  "bg-fuchsia-700 text-white dark:bg-fuchsia-400 dark:text-fuchsia-950",
];

/** A row's mark for what happened to its declaration, in the graphs' colours. */
const statusMark: Record<string, string> = {
  changed: "border-l-amber-400",
  added: "border-l-green-500",
  removed: "border-l-red-500",
};

const granularities: Array<{ value: Granularity; label: string }> = [
  { value: "package", label: "App or package" },
  { value: "folder", label: "Folder" },
  { value: "file", label: "File" },
];

/**
 * Matrix: which parts of the repository each change reaches. A row per
 * changed declaration, a column per app or package (or folder, or file) and
 * per point; a cell counts the declarations there that use the change,
 * directly or through others. Dark rows touch much; a column dark all the
 * way down is where many changes meet. Hover a cell for who's there, click
 * it for the list, linked to the code.
 */
export function MatrixView({ data, files, pageTitle }: ViewProps) {
  const [granularity, setGranularity] = useState<Granularity>("package");
  // The cell whose declarations are listed under its row.
  const [open, setOpen] = useState<{ row: string; column: string } | null>(null);
  const matrix = useMemo(() => changeMatrix(data, granularity), [data, granularity]);

  const hrefOf = new Map(files.map((file) => [file.path, file.href]));
  // A declaration on the page: its file's href with its name, as the graphs link it.
  const linkOf = (declaration: GraphDeclaration) => {
    const href = hrefOf.get(declaration.path);
    return href === undefined ? null : `${href}--${encodeURIComponent(declaration.label)}`;
  };

  if (matrix.rows.length === 0) return <GraphNote>No declaration's code that runs changed, was added or removed.</GraphNote>;

  const all = [...matrix.columns, ...matrix.points];
  const width = 2 + all.length;

  return (
    <section className="mt-2 rounded-md border border-neutral-200 text-xs dark:border-neutral-800">
      <header className="space-y-2 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <h3 className="font-semibold text-neutral-800 dark:text-neutral-100">
          What each change reaches, per {granularity === "package" ? "app or package" : granularity}
          <span className="ml-2 font-normal text-neutral-500">{pageTitle}</span>
        </h3>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-neutral-600 dark:text-neutral-400">
          <span className="inline-flex overflow-hidden rounded border border-neutral-300 dark:border-neutral-700" role="group" aria-label="Columns">
            {granularities.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={granularity === option.value}
                onClick={() => {
                  setGranularity(option.value);
                  setOpen(null);
                }}
                className={
                  granularity === option.value
                    ? "bg-neutral-800 px-2 py-0.5 text-white dark:bg-neutral-200 dark:text-neutral-900"
                    : "px-2 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                }
              >
                {option.label}
              </button>
            ))}
          </span>
          <Swatch className="border-sky-300 bg-sky-200 dark:border-sky-700 dark:bg-sky-800">declarations there that use the change</Swatch>
          <Swatch className="border-fuchsia-300 bg-fuchsia-200 dark:border-fuchsia-700 dark:bg-fuchsia-800">of those (and the change), the ones that reach a point</Swatch>
          <span className="inline-flex items-center gap-2">
            <span className="border-l-4 border-l-amber-400 pl-1">changed</span>
            <span className="border-l-4 border-l-green-500 pl-1">new</span>
            <span className="border-l-4 border-l-red-500 pl-1">removed</span>
          </span>
        </div>
        <p className="text-neutral-500">
          Hover a cell for the declarations in it; click it to list them under the row, linked to their code. Totals count each declaration once.
          {data.ripple.affected > data.ripple.shown && ` Counted from the nearest ${data.ripple.shown} of ${data.ripple.affected} affected declarations.`}
        </p>
      </header>

      {/* Scrolls on its own, the headers and the changes stuck to its edges: a wide or long matrix stays readable. */}
      <div className="max-h-[75vh] overflow-auto">
        <table className="border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-30 w-64 min-w-64 border-r border-b border-neutral-200 bg-white px-2 py-1 text-left align-bottom font-semibold text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">
                Changed declaration
              </th>
              <th
                className="sticky top-0 left-64 z-30 w-12 min-w-12 border-r border-b border-neutral-200 bg-white px-1 py-1 text-right align-bottom font-semibold text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200"
                title="Declarations its change reaches, everywhere"
              >
                Total
              </th>
              {all.map((column, index) => (
                <ColumnHeader key={column.key} column={column} firstPoint={column.kind === "point" && index === matrix.columns.length} />
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => {
              const openColumn = open?.row === row.declaration.id ? all.find((column) => column.key === open.column) : undefined;
              return (
                <Fragment key={row.declaration.id}>
                  <tr className="group">
                    <RowHeader row={row} href={linkOf(row.declaration)} />
                    <td className="sticky left-64 z-10 border-r border-b border-neutral-200 bg-white px-1 text-right font-semibold tabular-nums text-neutral-700 group-hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200 dark:group-hover:bg-neutral-900">
                      {row.total === 0 ? "" : row.total}
                    </td>
                    {all.map((column, index) => (
                      <Cell
                        key={column.key}
                        row={row}
                        column={column}
                        max={column.kind === "point" ? matrix.pointMax : matrix.max}
                        firstPoint={column.kind === "point" && index === matrix.columns.length}
                        isOpen={openColumn?.key === column.key}
                        onToggle={() => setOpen(openColumn?.key === column.key ? null : { row: row.declaration.id, column: column.key })}
                      />
                    ))}
                  </tr>
                  {openColumn !== undefined && (
                    <tr>
                      <td colSpan={width} className="border-b border-neutral-200 bg-neutral-50 p-0 dark:border-neutral-800 dark:bg-neutral-900">
                        <Reached row={row} column={openColumn} linkOf={linkOf} onClose={() => setOpen(null)} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th className="sticky bottom-0 left-0 z-30 border-t border-r border-neutral-300 bg-white px-2 py-1 text-left font-semibold text-neutral-700 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200">
                Reached by any change
              </th>
              <td className="sticky bottom-0 left-64 z-30 border-t border-r border-neutral-300 bg-white px-1 text-right font-semibold tabular-nums dark:border-neutral-700 dark:bg-neutral-950">
                {matrix.total}
              </td>
              {all.map((column, index) => (
                <td
                  key={column.key}
                  className={`sticky bottom-0 z-20 border-t border-neutral-300 bg-white text-center font-semibold tabular-nums dark:border-neutral-700 dark:bg-neutral-950 ${column.kind === "point" && index === matrix.columns.length ? "border-l-2 border-l-fuchsia-300 dark:border-l-fuchsia-800" : ""}`}
                  title={`${column.total} declaration${column.total === 1 ? "" : "s"} in ${column.title}, each counted once`}
                >
                  {column.total}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

/** A column's name, turned on its side so many columns fit; the whole path on hover. */
function ColumnHeader({ column, firstPoint }: { column: MatrixColumn; firstPoint: boolean }) {
  return (
    <th
      className={`sticky top-0 z-20 h-40 w-7 min-w-7 border-b border-neutral-200 bg-white px-0.5 pb-1 align-bottom font-normal dark:border-neutral-800 dark:bg-neutral-950 ${
        column.kind === "point" ? "text-fuchsia-700 dark:text-fuchsia-300" : "text-neutral-700 dark:text-neutral-300"
      } ${firstPoint ? "border-l-2 border-l-fuchsia-300 dark:border-l-fuchsia-800" : ""}`}
      title={column.kind === "point" ? `Point: ${column.title}` : column.title}
    >
      <span className="mx-auto block max-h-36 truncate whitespace-nowrap [writing-mode:vertical-rl] rotate-180">
        {column.kind === "point" ? `◆ ${column.label}` : column.label}
      </span>
    </th>
  );
}

/** The changed declaration: its name (to its code) and its file, marked by what happened to it. */
function RowHeader({ row, href }: { row: MatrixRow; href: string | null }) {
  const { declaration } = row;
  const name = <span className={declaration.status === "removed" ? "line-through" : ""}>{declaration.label}</span>;
  return (
    <th
      scope="row"
      className={`sticky left-0 z-10 w-64 max-w-64 min-w-64 border-r border-b border-l-4 border-neutral-200 bg-white px-2 py-0.5 text-left font-normal group-hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:group-hover:bg-neutral-900 ${statusMark[declaration.status] ?? ""}`}
      title={`${declaration.label} in ${declaration.path}: ${declaration.status}`}
    >
      <span className="block truncate font-mono text-neutral-900 dark:text-neutral-100">
        {href === null ? name : (
          <a href={href} className="hover:underline">
            {name}
          </a>
        )}
      </span>
      <span className="block truncate text-[10px] text-neutral-500" dir="rtl">
        {/* The end of the path is what tells files apart: cut from the left. */}
        <bdi>{declaration.path}</bdi>
      </span>
    </th>
  );
}

function Cell({ row, column, max, firstPoint, isOpen, onToggle }: { row: MatrixRow; column: MatrixColumn; max: number; firstPoint: boolean; isOpen: boolean; onToggle: () => void }) {
  const reached = row.cells.get(column.key) ?? [];
  const border = `border-b border-neutral-100 dark:border-neutral-900 ${firstPoint ? "border-l-2 border-l-fuchsia-300 dark:border-l-fuchsia-800" : ""}`;
  if (reached.length === 0) return <td className={border} />;
  const shade = (column.kind === "point" ? pointShades : areaShades)[shadeOf(reached.length, max)];
  const what = column.kind === "point" ? `reach ${column.label}` : `in ${column.title} use it`;
  const names = reached.slice(0, 10).map((declaration) => `• ${declaration.label} (${declaration.path.split("/").at(-1)})`);
  const more = reached.length > 10 ? [`… and ${reached.length - 10} more: click to list them`] : [];
  return (
    <td className={`p-0 ${border}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        title={[`${row.declaration.label}: ${reached.length} declaration${reached.length === 1 ? "" : "s"} ${what}`, ...names, ...more].join("\n")}
        className={`block h-7 w-full min-w-7 text-center tabular-nums hover:outline-2 hover:-outline-offset-2 hover:outline-neutral-900 dark:hover:outline-white ${shade} ${isOpen ? "outline-2 -outline-offset-2 outline-neutral-900 dark:outline-white" : ""}`}
      >
        {reached.length}
      </button>
    </td>
  );
}

/** A cell's declarations under its row, each linked to its code, by file. */
function Reached({ row, column, linkOf, onClose }: { row: MatrixRow; column: MatrixColumn; linkOf: (declaration: GraphDeclaration) => string | null; onClose: () => void }) {
  const reached = row.cells.get(column.key) ?? [];
  const byPath = new Map<string, Array<GraphDeclaration>>();
  for (const declaration of reached) byPath.set(declaration.path, [...(byPath.get(declaration.path) ?? []), declaration]);
  return (
    // Stuck to the left: the list stays in view however far the matrix is scrolled sideways.
    <div className="sticky left-0 max-w-[min(100%,48rem)] px-3 py-2">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="font-semibold text-neutral-800 dark:text-neutral-100">
          {column.kind === "point"
            ? `${row.declaration.label}, and what uses it, reaching ${column.label}: ${reached.length}`
            : `What uses ${row.declaration.label} in ${column.title}: ${reached.length}`}
        </span>
        <button type="button" onClick={onClose} className="text-neutral-500 hover:underline">
          close
        </button>
      </div>
      <ul className="columns-1 gap-6 sm:columns-2">
        {[...byPath.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, declarations]) => (
            <li key={path} className="mb-1 break-inside-avoid">
              <span className="block truncate text-[10px] text-neutral-500" title={path}>
                {path}
              </span>
              <span className="flex flex-wrap gap-x-2 font-mono">
                {declarations
                  .sort((a, b) => a.line - b.line)
                  .map((declaration) => {
                    const href = linkOf(declaration);
                    return href === null ? (
                      <span key={declaration.id}>{declaration.label}</span>
                    ) : (
                      <a key={declaration.id} href={href} className="text-sky-700 hover:underline dark:text-sky-300">
                        {declaration.label}
                      </a>
                    );
                  })}
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}
