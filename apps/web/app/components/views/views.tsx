import type { ChangeView } from "#/components/changes.tsx";
import { GraphNote, useGraph } from "#/components/graphs.tsx";
import { HeatmapView } from "#/components/views/heatmap.tsx";
import { MatrixView } from "#/components/views/matrix.tsx";
import { OrderView } from "#/components/views/order.tsx";
import { PerChangeView } from "#/components/views/per-change.tsx";
import { PointsView } from "#/components/views/points.tsx";
import { RingsView } from "#/components/views/rings.tsx";
import { StructureView } from "#/components/views/structure.tsx";
import { ZoomView } from "#/components/views/zoom.tsx";
import { unchangedFiles, type GraphFile, type ScannedGraph } from "#/graphs.ts";

/**
 * What every other view of the declaration graph gets: the scanned graph,
 * the files a declaration can link to (a changed file's above, an unchanged
 * one's in the list below, see UnchangedDeclarations), and what these
 * changes are, in one line (for a bar that stays when the header scrolls away).
 */
export type ViewProps = { data: ScannedGraph; files: Array<GraphFile>; pageTitle: string };

/**
 * Above the files on the tabs that show the declaration graph another way
 * than Ripple: once it's found, the view the tab names.
 */
export function OtherViewPanel({ view, files, pageTitle }: { view: ChangeView; files: Array<GraphFile>; pageTitle: string }) {
  const data = useGraph();
  if (data === null) return <GraphNote>Following the changes through the repository's declarations…</GraphNote>;
  if (data.status === "too-large") return <GraphNote>Not scanned: {data.sourceFiles} source files is more than a page can wait for.</GraphNote>;
  if (data.status === "failed") return <GraphNote>The declarations couldn't be followed: {data.message}</GraphNote>;

  const linked = [...files, ...unchangedFiles(data, new Set(files.map((file) => file.path))).map((file) => ({ path: file.path, href: `#${file.id}` }))];
  const props = { data, files: linked, pageTitle };
  if (view === "points") return <PointsView {...props} />;
  if (view === "zoom") return <ZoomView {...props} />;
  if (view === "rings") return <RingsView {...props} />;
  if (view === "per-change") return <PerChangeView {...props} />;
  if (view === "structure") return <StructureView {...props} />;
  if (view === "matrix") return <MatrixView {...props} />;
  if (view === "order") return <OrderView {...props} />;
  if (view === "heatmap") return <HeatmapView {...props} />;
  return null;
}
