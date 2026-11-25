import { useMemo, type ReactNode } from "react";
import { useLocation } from "react-router";
import type { ChangedFile } from "#/changes.server.ts";
import { ChangesBody, ChangesView, FileTree, ViewTabs, type ChangeView } from "#/components/changes.tsx";
import { GraphPanel, GraphProvider } from "#/components/graphs.tsx";
import { ReachPanel, ReachProvider } from "#/components/reach.tsx";
import { runsChanged } from "#/graphs.ts";
import { fileChangesPath } from "#/paths.ts";

/**
 * A page of changes: a commit, a comparison of branches, or the work tree's
 * current changes. They're one page so they stay alike: the header on top,
 * then the tabs, the Reach panel and the files. What differs is passed in:
 * the header, the files, where a file's full changes are fetched from, and
 * where the reach scan is (fetched once the page is shown: the page shows
 * the files first, and the reach when it's scanned).
 *
 * The address keeps what's chosen, so it can be shared and reloaded:
 * `?view=` the tab (reach unless asked), `?open=` files whose code is on
 * the page.
 */
export function ChangesPage({
  pageKey,
  title,
  header,
  files,
  repository,
  range,
  reachHref,
  graphHref,
}: {
  /** Another key (another commit, ...) starts the page fresh: scrolled to the top, files closed. */
  pageKey: string;
  /** What these changes are, in one line: a commit's subject, "branch since base". Where the header has scrolled away (the graph's bar). */
  title: string;
  header: ReactNode;
  files: Array<ChangedFile>;
  /** The repository's path in the app, and what the files changed between: where opening a file fetches its code. */
  repository: string;
  range: { commit: string } | { from: string; to: string };
  /** The reach route for these changes (see `reachPath`). */
  reachHref: string;
  /** The graph route for these changes (see `graphPath`): their import links, for the graph tabs. */
  graphHref: string;
}) {
  // Only the address's path and query matter here: jumping to a file (its
  // #hash) must not rebuild these, or the whole page renders again.
  const { pathname, search } = useLocation();
  const rangeKey = "commit" in range ? range.commit : `${range.from}..${range.to}`;

  const entries = useMemo(
    () =>
      files.map((file, index) => ({
        file: file,
        id: `file-${index}`,
        loadHref: withOpenFile({ pathname, search }, file.path, `file-${index}`),
        codeHref: fileChangesPath(repository, range, file),
      })),
    // `range` is a new object each render; `rangeKey` is what it says.
    [files, repository, rangeKey, pathname, search],
  );

  const asked = new URLSearchParams(search).get("view");
  const view: ChangeView =
    asked === "declarations" ||
    asked === "lines" ||
    asked === "module" ||
    asked === "combined" ||
    asked === "folded" ||
    asked === "bundled" ||
    asked === "zoom" ||
    asked === "flow" ||
    asked === "neighbors" ||
    asked === "calls" ||
    asked === "points"
      ? asked
      : "reach";
  // Ripple + import map, and its four ways for big ripples: the graph stays
  // in the top of the code while the files scroll below it, so a node
  // clicked shows its code under the graph (see GraphFrame's `fill`).
  const stickyGraph = view === "combined" || view === "folded" || view === "bundled" || view === "zoom";
  const graph = stickyGraph || view === "flow" || view === "calls" || view === "points";
  // The views that show declarations are about what runs: a file where only
  // types, comments or formatting changed isn't on them, nor in their tree.
  // The line diff and imports & exports show every file.
  const shown = useMemo(() => (view === "lines" || view === "module" ? entries : entries.filter((entry) => runsChanged(entry.file))), [entries, view]);
  // The graphs' files: each one shown, and where it is on the page. Not the
  // tests and stories: the page sets them aside, so do the graphs.
  const graphFiles = useMemo(
    () => shown.filter((entry) => entry.file.ignoredBy === null).map((entry) => ({ file: entry.file, href: `#${entry.id}` })),
    [shown],
  );
  const tabs = [
    { view: "reach" as const, label: "Reach", href: withView({ pathname, search }, "reach") },
    { view: "declarations" as const, label: "Full declarations that changed", href: withView({ pathname, search }, "declarations") },
    { view: "lines" as const, label: "Line diff", href: withView({ pathname, search }, "lines") },
    { view: "module" as const, label: "Imports & exports", href: withView({ pathname, search }, "module") },
    { view: "combined" as const, label: "Ripple", href: withView({ pathname, search }, "combined"), experimental: true },
    // More ways to read a big ripple, to try: each Ripple + import map with one change (focus on click is in all).
    { view: "folded" as const, label: "Ripple: far files folded", href: withView({ pathname, search }, "folded"), experimental: true },
    { view: "bundled" as const, label: "Ripple: one line per file", href: withView({ pathname, search }, "bundled"), experimental: true },
    { view: "zoom" as const, label: "Ripple: detail by zoom", href: withView({ pathname, search }, "zoom"), experimental: true },
    { view: "flow" as const, label: "Reach flow", href: withView({ pathname, search }, "flow"), experimental: true },
    { view: "neighbors" as const, label: "Neighbors", href: withView({ pathname, search }, "neighbors"), experimental: true },
    { view: "calls" as const, label: "Calls", href: withView({ pathname, search }, "calls"), experimental: true },
    { view: "points" as const, label: "Points", href: withView({ pathname, search }, "points"), experimental: true },
  ];

  return (
    <ReachProvider href={reachHref}>
      <GraphProvider href={graphHref} enabled={graph || view === "neighbors"}>
        <ChangesView key={pageKey} tree={<FileTree entries={shown} />}>
          {header}
          <ViewTabs current={view} tabs={tabs} />
          {view === "reach" && <ReachPanel />}
          {graph && <GraphPanel view={view} files={graphFiles} fill={stickyGraph} pageTitle={title} />}
          <ChangesBody entries={shown} view={view} />
        </ChangesView>
      </GraphProvider>
    </ReachProvider>
  );
}

/** This page in another view: reach is the default, so it isn't in the address. */
function withView(location: { pathname: string; search: string }, view: ChangeView): string {
  const query = new URLSearchParams(location.search);
  if (view === "reach") query.delete("view");
  else query.set("view", view);
  return query.size === 0 ? location.pathname : `${location.pathname}?${query}`;
}

/** This page again, with one more file's code on it (`?open=`), scrolled to it. */
function withOpenFile(location: { pathname: string; search: string }, path: string, id: string): string {
  const query = new URLSearchParams(location.search);
  query.append("open", path);
  return `${location.pathname}?${query}#${id}`;
}
