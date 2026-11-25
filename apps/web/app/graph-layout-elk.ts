import ElkModule, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { Graph, GraphLayout, PlacedEdge, PlacedGroup, PlacedNode } from "#/graphs.ts";

/**
 * Where everything goes, as `layoutGraph` (graphs.ts) but with ELK's layered
 * layout instead of dagre: made for boxes in a graph (a box per file, in a box per app),
 * where dagre's support for them fails on some graphs. Left to right; x and y
 * are centers, text measured as 7px a character (12px monospace), as there.
 * Asynchronous: ELK answers with a promise, even run on the page itself.
 */
export async function layoutGraphElk(graph: Graph): Promise<GraphLayout> {
  const groupIds = new Set(graph.groups.map((group) => group.id));
  const sizeOf = (node: Graph["nodes"][number]) => ({
    width: Math.min(Math.max(node.label.length, node.note?.length ?? 0), 48) * 7 + 20,
    height: node.note === null ? 26 : 40,
  });

  // A box per file, its declarations in it, in its app's box if it has a
  // `parent`; what has no box, at the top.
  const boxOf = (group: Graph["groups"][number]): ElkNode => ({
    id: group.id,
    // The box's name sits above its top line (see GraphDrawing): room for it inside; an app's is larger.
    layoutOptions: { "elk.padding": group.id.startsWith("package:") ? "[top=46,left=16,bottom=16,right=16]" : "[top=16,left=12,bottom=12,right=12]" },
    children: [
      ...graph.groups.filter((child) => child.parent === group.id).map(boxOf),
      ...graph.nodes.filter((node) => node.group === group.id).map((node) => ({ id: node.id, ...sizeOf(node) })),
    ],
  });
  const boxes: Array<ElkNode> = graph.groups.filter((group) => group.parent === undefined || !groupIds.has(group.parent)).map(boxOf);
  const loose: Array<ElkNode> = graph.nodes
    .filter((node) => node.group === null || !groupIds.has(node.group))
    .map((node) => ({ id: node.id, ...sizeOf(node) }));

  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  // At the top, all of them: ELK lays out the boxes and what's in them as one
  // graph (INCLUDE_CHILDREN), so arrows between boxes are routed with the rest.
  const edges: Array<ElkExtendedEdge> = graph.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to)
    .map((edge, index) => ({ id: `edge-${index}`, sources: [edge.from], targets: [edge.to] }));
  const kept = graph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to);

  // elkjs is CommonJS: TypeScript sees the default import as the module, whose
  // `default` is the constructor (at run time both are).
  const elk = new ElkModule.default();
  const placed = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      // Straight lines: horizontal and vertical runs (GraphSvg rounds the
      // corners), and nodes placed to keep the runs level (network simplex).
      // Of splines, polylines and these, on a 254-node graph: the least
      // going up and down (394px an edge, splines 480) and the fewest bends.
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.spacing.nodeNodeBetweenLayers": "60",
      "elk.spacing.nodeNode": "18",
      "elk.spacing.edgeNode": "14",
      "elk.layered.spacing.edgeNodeBetweenLayers": "20",
      "elk.padding": "[top=28,left=16,bottom=16,right=16]",
      // Every position from the drawing's top left, not from the box it's in.
      "elk.json.shapeCoords": "ROOT",
      "elk.json.edgeCoords": "ROOT",
    },
    children: [...boxes, ...loose],
    edges,
  });

  // Where ELK put each node and box (top left), by id.
  const where = new Map<string, ElkNode>();
  const visit = (node: ElkNode) => {
    where.set(node.id, node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const child of placed.children ?? []) visit(child);

  const nodes: Array<PlacedNode> = graph.nodes.map((node) => {
    const at = where.get(node.id);
    const width = at?.width ?? 0;
    const height = at?.height ?? 0;
    return { ...node, x: (at?.x ?? 0) + width / 2, y: (at?.y ?? 0) + height / 2, width, height };
  });
  const groups: Array<PlacedGroup> = graph.groups.flatMap((group) => {
    const at = where.get(group.id);
    // A box with nothing in it (no declaration, no file's box) isn't drawn.
    if (at === undefined || (graph.nodes.every((node) => node.group !== group.id) && graph.groups.every((child) => child.parent !== group.id))) return [];
    const width = at.width ?? 0;
    const height = at.height ?? 0;
    return [{ ...group, x: (at.x ?? 0) + width / 2, y: (at.y ?? 0) + height / 2, width, height }];
  });
  const placedEdges: Array<PlacedEdge> = kept.map((edge, index) => {
    const sections = placed.edges?.find((candidate) => candidate.id === `edge-${index}`)?.sections ?? [];
    const points = sections.flatMap((section) => [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]);
    return { ...edge, points };
  });

  // As layoutGraph: the drawing is everything's bounds, a margin around,
  // moved to start at 0, with room for a box's name above it.
  const xs = [
    ...nodes.flatMap((node) => [node.x - node.width / 2, node.x + node.width / 2]),
    ...groups.flatMap((group) => [group.x - group.width / 2, group.x + group.width / 2]),
    ...placedEdges.flatMap((edge) => edge.points.map((point) => point.x)),
  ];
  const ys = [
    ...nodes.flatMap((node) => [node.y - node.height / 2, node.y + node.height / 2]),
    ...groups.flatMap((group) => [group.y - group.height / 2 - 14, group.y + group.height / 2]),
    ...placedEdges.flatMap((edge) => edge.points.map((point) => point.y)),
  ];
  const margin = 16;
  const left = Math.min(...xs) - margin;
  const top = Math.min(...ys) - margin;
  const move = <Placed extends { x: number; y: number }>(item: Placed): Placed => ({ ...item, x: item.x - left, y: item.y - top });
  return {
    width: Math.max(...xs) - left + margin,
    height: Math.max(...ys) - top + margin,
    nodes: nodes.map(move),
    groups: groups.map(move),
    edges: placedEdges.map((edge) => ({ ...edge, points: edge.points.map(move) })),
    withoutBoxes: false,
  };
}
