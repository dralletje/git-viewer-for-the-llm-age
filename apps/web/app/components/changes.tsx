import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useFetcher } from "react-router";
import type { FileDiff, FileStatus } from "@room/diff";
import type { ChangedUnit, ExportChange, ImportChange, UsedChange } from "@room/syntax";
import type { AnalyzedDeclaration, AnalyzedFile, AnalyzedHunk, DeclarationRow, OutsideChange } from "#/analyze-diff.server.ts";
import { inFileOrder } from "#/declaration-order.ts";
import { MiniGraph } from "#/components/graphs.tsx";
import { ReachChips } from "#/components/reach.tsx";
import { nothingRuns } from "#/graphs.ts";
import { buildFileTree, filesInTreeOrder, type FileTreeNode } from "#/file-tree.ts";

/** One changed file on a commit or comparison page. */
export type ChangeEntry = {
  file: AnalyzedFile & { ignoredBy: string | null };
  /** Its element id: the tree links to `#id`. */
  id: string;
  /** This page with the file's code on it: what opening it does without JavaScript. */
  loadHref: string;
  /** The file's analyzed changes as data: what opening it fetches with JavaScript. */
  codeHref: string;
};

/**
 * Ways of showing the changes, one tab each: experiments side by side, each
 * free to change without getting in another's way.
 * - declarations: per top-level declaration, old beside new, and the ones
 *   whose code is the same but uses code that changed.
 * - lines: the plain line diff.
 * - module: the line diff, with each file's imports and exports summed up.
 * - reach: declarations, with what the repository's files can reach outside
 *   the program (network, database, ...): what the commit adds, and each
 *   file's reach beside its name.
 * - combined ("Ripple"), flow: a graph of declarations above the
 *   declarations (see graphs.ts): what the changes spread to through the
 *   repository and the uses they added or removed, in a box per app or
 *   package; the chains to new reach.
 * - folded, bundled, zoom: combined, three more ways to read a big ripple
 *   without leaving anything out: far files folded, one line per file,
 *   detail by zoom. Every one of them (combined too) focuses a clicked
 *   declaration: all but the paths through it fade.
 * - neighbors: declarations, each header a small graph of what it uses that
 *   changed and what uses it.
 * - calls: what the changed code uses, which may now be called differently.
 * - points: what matters in the repository (its `.room.toml`, then the
 *   capabilities), and the changed code that reaches each.
 */
export type ChangeView = "declarations" | "lines" | "module" | "reach" | "combined" | "folded" | "bundled" | "zoom" | "flow" | "neighbors" | "calls" | "points";

/** The views that show each file as its declarations. */
function byDeclarations(view: ChangeView): boolean {
  return view !== "lines" && view !== "module";
}

/** The tabs: links to this page in another view (`?view=`), so a view can be shared and reloaded. */
export function ViewTabs({
  current,
  tabs,
}: {
  current: ChangeView;
  tabs: Array<{ view: ChangeView; label: string; href: string; experimental?: boolean }>;
}) {
  return (
    <nav className="mb-4 flex flex-wrap gap-1 border-b border-neutral-200 text-sm dark:border-neutral-800">
      {tabs.map((tab) => (
        <Link
          key={tab.view}
          to={tab.href}
          preventScrollReset
          aria-current={tab.view === current ? "page" : undefined}
          className="-mb-px border-b-2 border-transparent px-3 py-1.5 text-neutral-500 hover:text-neutral-900 aria-[current]:border-blue-600 aria-[current]:font-medium aria-[current]:text-neutral-900 dark:hover:text-neutral-100 dark:aria-[current]:text-neutral-100"
        >
          {tab.label}
          {tab.experimental === true && (
            <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-normal text-amber-800 dark:bg-amber-950 dark:text-amber-300">experimental</span>
          )}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The file tree and the code, together exactly the screen's width: the
 * commits and branches are off to the left, a scroll away. Each column
 * scrolls on its own; a new key (another commit, another comparison) starts
 * both at the top.
 */
export function ChangesView({ tree, children }: { tree: ReactNode; children: ReactNode }) {
  const treeColumn = useRef<HTMLElement>(null);
  const codeColumn = useRef<HTMLDivElement>(null);
  // While a declaration is focused in the graph: how many files are left, and a way back to all.
  const [focused, setFocused] = useState<{ shown: number; of: number } | null>(null);

  // Jumping to a file and following which file is being read. Straight on
  // the page: marking the file through React state would render the tree
  // on every scroll.
  useEffect(() => {
    const code = codeColumn.current;
    const tree = treeColumn.current;
    if (code === null || tree === null) return;
    let current: string | null = null;
    // A file jumped to stays marked while it's in the top half of the code,
    // also when it's too short to reach the top (the last files).
    let jumpedTo: string | null = null;
    let frame = 0;

    // The tree marks the file being read (`data-current`) and keeps it in
    // view, by scrolling only the tree.
    const markFile = (id: string | null) => {
      if (id === current) return;
      tree.querySelectorAll("a[data-current]").forEach((link) => link.removeAttribute("data-current"));
      current = id;
      const link = id === null ? null : tree.querySelector(`a[href="#${id}"]`);
      if (link === null) return;
      link.setAttribute("data-current", "");
      const linkBox = link.getBoundingClientRect();
      const treeBox = tree.getBoundingClientRect();
      if (linkBox.height === 0) return;
      // 40px: the tree's sticky header.
      if (linkBox.top < treeBox.top + 40) tree.scrollTop -= treeBox.top + 40 - linkBox.top;
      else if (linkBox.bottom > treeBox.bottom) tree.scrollTop += linkBox.bottom - treeBox.bottom;
    };

    // The file under a line just below the top of the code; above the first
    // file (the header), the first file in view. With a graph stuck to the
    // top (Ripple + import map), the files' part starts below it.
    const fileBeingRead = (): string | null => {
      const whole = code.getBoundingClientRect();
      const graphBottom = code.querySelector("[data-sticky-graph]")?.getBoundingClientRect().bottom;
      const view = { top: graphBottom ?? whole.top, bottom: whole.bottom, height: whole.bottom - (graphBottom ?? whole.top) };
      if (jumpedTo !== null) {
        const box = document.getElementById(jumpedTo)?.getBoundingClientRect();
        if (box !== undefined && box.height > 0 && box.top < view.top + view.height / 2 && box.bottom > view.top) return jumpedTo;
        jumpedTo = null;
      }
      const line = view.top + 48;
      let found: string | null = null;
      for (const element of code.querySelectorAll("details[data-file]")) {
        const box = element.getBoundingClientRect();
        // A file in a folded group of set-aside files.
        if (box.height === 0) continue;
        if (box.top <= line) {
          found = element.id;
          continue;
        }
        if (found === null && box.top < view.bottom) found = element.id;
        break;
      }
      return found;
    };

    // Opens the file (or a declaration in it: `file-3--name`, see
    // DeclarationsView), and the group it's folded into, and puts it at the
    // top. A declaration that isn't on the page: its file.
    const jumpTo = (id: string) => {
      const target = document.getElementById(id) ?? document.getElementById(id.split("--")[0] ?? "");
      if (target === null) return;
      for (let element: HTMLElement | null = target; element !== null; element = element.parentElement) {
        if (element instanceof HTMLDetailsElement) element.open = true;
      }
      target.scrollIntoView({ block: "start" });
      const file = target.closest("details[data-file]")?.id ?? null;
      jumpedTo = file;
      markFile(file);
    };

    // A link to the file or declaration the address already points at (a
    // graph's node clicked twice): no hashchange, so jump here.
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href^='#file-']") : null;
      if (link === null || link.getAttribute("href") !== window.location.hash) return;
      event.preventDefault();
      jumpTo(decodeURIComponent(window.location.hash.slice(1)));
    };

    // With a graph stuck above the code: which declaration is being read,
    // for the graph to mark (see GraphCanvas). A window event: the graph is
    // drawn elsewhere on the page, and only needs the id.
    let reading: string | null = null;
    const markDeclaration = () => {
      const graph = code.querySelector("[data-sticky-graph]");
      if (graph === null) return;
      // Just below the graph and the file's sticky header.
      const line = graph.getBoundingClientRect().bottom + 72;
      let found: string | null = null;
      for (const element of code.querySelectorAll("details[data-file] details[id]")) {
        const box = element.getBoundingClientRect();
        if (box.height === 0) continue;
        if (box.top <= line && box.bottom > line) {
          found = element.id;
          break;
        }
      }
      if (found === reading) return;
      reading = found;
      window.dispatchEvent(new CustomEvent("room:reading", { detail: { id: found } }));
    };

    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        markFile(fileBeingRead());
        markDeclaration();
      });
    };

    // An address with #file-…: a file chosen in the tree, a shared link,
    // back/forward.
    const onHashChange = () => jumpTo(decodeURIComponent(window.location.hash.slice(1)));

    // A declaration focused in the graph (see GraphCanvas): the files its
    // paths go through stay; the rest are hidden below it and dimmed in the
    // tree. Straight on the page, as the marks above: the files are heavy.
    const onFocus = (event: Event) => {
      const files = (event as CustomEvent<{ files: Array<string> | null }>).detail.files;
      const keep = files === null ? null : new Set(files);
      for (const element of code.querySelectorAll("details[data-file]")) element.toggleAttribute("data-unfocused", keep !== null && !keep.has(element.id));
      for (const link of tree.querySelectorAll("a[href^='#file-']")) {
        link.toggleAttribute("data-unfocused", keep !== null && !keep.has(link.getAttribute("href")?.slice(1) ?? ""));
      }
      // Counted as the tree's header counts: the files to review, the set-aside ones not.
      const reviewed = [...code.querySelectorAll("details[data-file]:not([data-set-aside])")].map((element) => element.id);
      setFocused(keep === null ? null : { shown: reviewed.filter((id) => keep.has(id)).length, of: reviewed.length });
    };
    // Choosing a file in the tree ends the focus: every file is back, and so is the whole graph.
    const onTreeClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || event.target.closest("a[href^='#file-']") === null) return;
      if (code.querySelector("[data-unfocused]") === null) return;
      onFocus(new CustomEvent("room:focus", { detail: { files: null } }));
      window.dispatchEvent(new CustomEvent("room:focus-clear"));
    };

    if (window.location.hash.startsWith("#file-")) onHashChange();
    else markFile(fileBeingRead());
    code.addEventListener("scroll", onScroll, { passive: true });
    code.addEventListener("click", onClick);
    tree.addEventListener("click", onTreeClick);
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("room:focus", onFocus);
    return () => {
      cancelAnimationFrame(frame);
      code.removeEventListener("scroll", onScroll);
      code.removeEventListener("click", onClick);
      tree.removeEventListener("click", onTreeClick);
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("room:focus", onFocus);
    };
  }, []);

  return (
    <div className="flex h-full w-screen shrink-0 snap-end">
      <nav ref={treeColumn} className="w-72 shrink-0 overflow-y-auto border-r border-neutral-200 dark:border-neutral-800">
        {focused !== null && (
          <div className="flex items-center gap-2 border-b border-blue-200 bg-blue-50 px-4 py-1.5 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200">
            <span>
              Focused: {focused.shown} of {focused.of} files
            </span>
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(new CustomEvent("room:focus-clear"));
                window.dispatchEvent(new CustomEvent("room:focus", { detail: { files: null } }));
              }}
              className="ml-auto rounded border border-blue-300 px-1.5 py-0.5 hover:bg-blue-100 dark:border-blue-800 dark:hover:bg-blue-900"
            >
              Show all
            </button>
          </div>
        )}
        {tree}
      </nav>
      <div
        ref={codeColumn}
        // With a graph stuck to the top (Ripple), its height is --files-top
        // here (set by GraphFrame): a file's header sticks below it, and a
        // jump puts a file there.
        // overscroll-x-contain: a touchpad's swipe up or down is never quite
        // vertical, and this column can't scroll sideways, so the sideways
        // part went on to the branches | commits | code strip around it,
        // which then snapped to the commits. A swipe here stays here.
        className="min-w-0 flex-1 overflow-y-auto overscroll-x-contain p-6"
      >
        {children}
      </div>
    </div>
  );
}

/** The files set aside by each rule, in the order the rules first match. */
function ignoredGroups(entries: Array<ChangeEntry>): Array<{ rule: string; entries: Array<ChangeEntry> }> {
  const groups: Array<{ rule: string; entries: Array<ChangeEntry> }> = [];
  for (const entry of entries) {
    if (entry.file.ignoredBy === null) continue;
    let group = groups.find((candidate) => candidate.rule === entry.file.ignoredBy);
    if (group === undefined) {
      group = { rule: entry.file.ignoredBy, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

/**
 * The files to review as a tree; below it, each rule's set-aside files
 * folded into one line. Memoised, like the code: following a link to a file
 * changes the address, which re-renders the page, and only these are heavy.
 */
export const FileTree = memo(function FileTree({ entries }: { entries: Array<ChangeEntry> }) {
  const reviewed = entries.filter((entry) => entry.file.ignoredBy === null);
  const additions = reviewed.reduce((total, entry) => total + entry.file.additions, 0);
  const deletions = reviewed.reduce((total, entry) => total + entry.file.deletions, 0);
  return (
    <div>
      <h2 className="sticky top-0 z-10 flex items-center gap-2 border-b border-neutral-200 bg-white px-4 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-950">
        <span className="font-semibold">
          {reviewed.length} {reviewed.length === 1 ? "file" : "files"}
        </span>
        <span className="ml-auto">
          <Counts additions={additions} deletions={deletions} />
        </span>
      </h2>
      <div className="py-1">
        <FileTreeNodes nodes={buildFileTree(reviewed, (entry) => entry.file.path)} depth={0} />
      </div>
      {ignoredGroups(entries).map((group) => (
        <details key={group.rule} className="border-t border-neutral-200 dark:border-neutral-800">
          <summary className="flex cursor-pointer items-center gap-2 px-4 py-1.5 text-xs text-neutral-500 hover:bg-neutral-50 dark:hover:bg-neutral-900">
            <span>
              {group.entries.length} {group.rule} set aside
            </span>
            <span className="ml-auto opacity-70">
              <Counts additions={group.entries.reduce((total, entry) => total + entry.file.additions, 0)} deletions={group.entries.reduce((total, entry) => total + entry.file.deletions, 0)} />
            </span>
          </summary>
          <div className="pb-1 opacity-75">
            <FileTreeNodes nodes={buildFileTree(group.entries, (entry) => entry.file.path)} depth={0} />
          </div>
        </details>
      ))}
    </div>
  );
});

/** Folders are <details>: they fold without JavaScript. */
function FileTreeNodes({ nodes, depth }: { nodes: Array<FileTreeNode<ChangeEntry>>; depth: number }) {
  const indent = { paddingLeft: `${0.75 + depth * 0.9}rem` };
  return (
    <ul>
      {nodes.map((node) =>
        node.kind === "folder" ? (
          <li key={`folder:${node.path}`}>
            <details open>
              <summary style={indent} className="cursor-pointer truncate py-0.5 pr-3 font-mono text-xs text-neutral-500 hover:bg-neutral-50 dark:hover:bg-neutral-900">
                {node.name}/
              </summary>
              <FileTreeNodes nodes={node.children} depth={depth + 1} />
            </details>
          </li>
        ) : (
          <li key={`file:${node.path}`}>
            <a
              href={`#${node.file.id}`}
              title={node.path}
              style={indent}
              className="flex items-center gap-1.5 py-0.5 pr-3 hover:bg-neutral-100 data-[current]:bg-sky-100 data-[current]:font-semibold data-[unfocused]:opacity-35 dark:hover:bg-neutral-900 dark:data-[current]:bg-sky-950"
            >
              <StatusBadge status={node.file.file.status} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{node.name}</span>
              <Counts additions={node.file.file.additions} deletions={node.file.file.deletions} />
            </a>
          </li>
        ),
      )}
    </ul>
  );
}

/**
 * The files, in the tree's order (reading down one reads down the other);
 * then each rule's set-aside files, folded into one line that opens to
 * their headers.
 */
export const ChangesBody = memo(function ChangesBody({ entries, view }: { entries: Array<ChangeEntry>; view: ChangeView }) {
  const reviewed = entries.filter((entry) => entry.file.ignoredBy === null);
  return (
    <div className="mt-6 flex flex-col gap-4">
      {filesInTreeOrder(buildFileTree(reviewed, (entry) => entry.file.path)).map((entry) => (
        <FileDiffView key={entry.id} entry={entry} view={view} />
      ))}
      {ignoredGroups(entries).map((group) => (
        <details
          key={group.rule}
          // Open when one of its files was asked to show its code.
          open={group.entries.some((entry) => !entry.file.codeOmitted)}
          className="rounded-md border border-dashed border-neutral-300 dark:border-neutral-700"
        >
          <summary className="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm text-neutral-500">
            <span>
              {group.entries.length} {group.rule} changed, set aside
            </span>
            <span className="ml-auto">
              <Counts additions={group.entries.reduce((total, entry) => total + entry.file.additions, 0)} deletions={group.entries.reduce((total, entry) => total + entry.file.deletions, 0)} />
            </span>
          </summary>
          <div className="flex flex-col gap-2 p-2">
            {filesInTreeOrder(buildFileTree(group.entries, (entry) => entry.file.path)).map((entry) => (
              <FileDiffView key={entry.id} entry={entry} view={view} />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
});

const statusStyle: Record<FileStatus, { letter: string; className: string }> = {
  added: { letter: "A", className: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" },
  deleted: { letter: "D", className: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
  modified: { letter: "M", className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  renamed: { letter: "R", className: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" },
  copied: { letter: "C", className: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" },
};

function StatusBadge({ status }: { status: FileStatus }) {
  const style = statusStyle[status];
  return (
    <span title={status} className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold ${style.className}`}>
      {style.letter}
    </span>
  );
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-xs">
      <span className="text-green-700 dark:text-green-400">+{additions}</span> <span className="text-red-700 dark:text-red-400">−{deletions}</span>
    </span>
  );
}

function FilePath({ file }: { file: FileDiff }) {
  if ((file.status === "renamed" || file.status === "copied") && file.oldPath !== null) {
    return (
      <span className="truncate font-mono text-sm">
        <span className="text-neutral-500">{file.oldPath} → </span>
        {file.newPath}
      </span>
    );
  }
  return <span className="truncate font-mono text-sm">{file.path}</span>;
}

/**
 * A <details>, so opening and closing a file works without JavaScript.
 * Closed, it shows the file's imports and exports. On Reach, a file without
 * declarations (text, JSON, config) starts closed. A file whose code isn't
 * on the page fetches it when opened; without JavaScript, its "Show
 * changes" link loads the page again with it.
 */
export const FileDiffView = memo(function FileDiffView({ entry, view }: { entry: ChangeEntry; view: ChangeView }) {
  const fetcher = useFetcher<{ file: AnalyzedFile }>();
  const file: AnalyzedFile = fetcher.data?.file ?? entry.file;
  const loading = fetcher.state !== "idle";

  return (
    <details
      id={entry.id}
      // A file, not one of its declarations (whose ids start alike): what the tree follows.
      data-file=""
      // A test, story or what the .room.toml sets aside: not counted among the files to review.
      data-set-aside={entry.file.ignoredBy === null ? undefined : ""}
      // Reach is for reading code: a file with no declarations (text, JSON,
      // config) starts closed there, or its whole line diff fills the page.
      open={!entry.file.codeOmitted && !(view === "reach" && entry.file.declarations === null)}
      onToggle={(event) => {
        if (event.currentTarget.open && file.codeOmitted && !file.binary && !loading) fetcher.load(entry.codeHref);
      }}
      // data-unfocused: not on the paths of the declaration focused in the graph (see ChangesView).
      className="group scroll-mt-[calc(var(--files-top,0px)+1rem)] data-[unfocused]:hidden rounded-md border border-neutral-200 [contain-intrinsic-size:auto_240px] [content-visibility:auto] dark:border-neutral-800"
    >
      <summary className="sticky top-[var(--files-top,0px)] z-10 block cursor-pointer rounded-t-md border-b border-neutral-200 bg-neutral-50 px-4 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center gap-2">
          <StatusBadge status={file.status} />
          <FilePath file={file} />
          {file.oldMode !== null && file.newMode !== null && file.oldMode !== file.newMode && (
            <span className="font-mono text-xs text-neutral-500">
              {file.oldMode} → {file.newMode}
            </span>
          )}
          {view === "reach" && <ReachChips path={file.path} />}
          <span className="ml-auto">
            <Counts additions={file.additions} deletions={file.deletions} />
          </span>
        </div>
        {byDeclarations(view) && file.declarations !== null && (
          <div className="mt-2 flex gap-2 group-open:hidden">
            <span className="w-14 shrink-0 pt-0.5 text-xs text-neutral-500">changed</span>
            <DeclarationChips declarations={file.declarations.filter((declaration) => !nothingRuns(declaration))} />
          </div>
        )}
        {view === "module" && file.imports !== null && (
          <div className="mt-2 flex gap-2 group-open:hidden">
            <span className="w-14 shrink-0 pt-0.5 text-xs text-neutral-500">imports</span>
            <ImportList imports={file.imports} />
          </div>
        )}
        {view === "module" && file.module !== null && file.module.exports.length > 0 && (
          <div className="mt-1.5 flex gap-2 group-open:hidden">
            <span className="w-14 shrink-0 pt-0.5 text-xs text-neutral-500">exports</span>
            <ExportList exports={file.module.exports} />
          </div>
        )}
        {view === "module" && file.module !== null && file.module.unreachable.length > 0 && (
          <div className="mt-1.5 flex gap-2 group-open:hidden" title="Changed, but no export and no top-level code uses it: dead code, or an unused import.">
            <span className="w-14 shrink-0 pt-0.5 text-xs text-neutral-500">unused</span>
            <UnitList units={file.module.unreachable} className="border-dashed border-orange-400 text-orange-900 dark:border-orange-700 dark:text-orange-200" />
          </div>
        )}
        {view === "module" && file.module !== null && file.module.statements.length > 0 && (
          <div className="mt-1.5 flex gap-2 group-open:hidden" title="Changed top-level code: it runs when the file is imported.">
            <span className="w-14 shrink-0 pt-0.5 text-xs text-neutral-500">runs</span>
            <UnitList units={file.module.statements} className="border-amber-300 text-amber-900 dark:border-amber-800 dark:text-amber-200" />
          </div>
        )}
      </summary>
      {file.binary ? (
        <p className="px-4 py-3 text-sm text-neutral-500">Binary file, not shown.</p>
      ) : file.codeOmitted && loading ? (
        <p className="px-4 py-3 text-sm text-neutral-500">Loading {file.additions + file.deletions} changed lines…</p>
      ) : file.codeOmitted ? (
        <p className="px-4 py-3 text-sm text-neutral-500">
          {file.additions + file.deletions} changed lines, not on this page to keep it fast.{" "}
          <Link to={entry.loadHref} className="text-blue-700 underline dark:text-blue-400">
            Show changes
          </Link>
        </p>
      ) : file.hunks.length === 0 ? (
        <p className="px-4 py-3 text-sm text-neutral-500">No changes to the contents.</p>
      ) : byDeclarations(view) && file.declarations !== null ? (
        <DeclarationsView
          fileId={entry.id}
          file={file}
          declarations={file.declarations}
          // Ripple + import map is read declaration by declaration from the graph: all open.
          openAll={view === "combined" || view === "folded" || view === "bundled" || view === "zoom"}
          // The other views are read for what the code does: no list of what didn't change.
          listUnchanged={view === "declarations"}
          neighbors={view === "neighbors"}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-xs leading-5">
            {file.hunks.map((hunk, index) => (
              <HunkRows key={index} hunk={hunk} tokenKinds={file.tokenKinds} />
            ))}
          </table>
        </div>
      )}
    </details>
  );
});

const declarationStyle: Record<AnalyzedDeclaration["status"], { word: string; className: string }> = {
  added: { word: "added", className: "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/50 dark:text-green-200" },
  removed: { word: "removed", className: "border-red-300 bg-red-50 text-red-900 line-through dark:border-red-800 dark:bg-red-950/50 dark:text-red-200" },
  changed: { word: "changed", className: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200" },
  affected: { word: "affected", className: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-200" },
  types: { word: "types", className: "border-dashed border-indigo-300 text-indigo-800 dark:border-indigo-700 dark:text-indigo-300" },
  comments: { word: "comments", className: "border-dashed border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400" },
  formatting: { word: "formatting", className: "border-dashed border-neutral-300 text-neutral-500 dark:border-neutral-700" },
  unchanged: { word: "unchanged", className: "border-neutral-200 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400" },
};

/** The declarations that changed, as chips: what a closed file shows first. */
function DeclarationChips({ declarations }: { declarations: Array<AnalyzedDeclaration> }) {
  const shown = declarations.filter((declaration) => declaration.status !== "unchanged");
  if (shown.length === 0) return <p className="text-xs text-neutral-500">No declaration changed.</p>;
  return (
    <ul className="flex flex-wrap gap-1.5 font-mono text-xs">
      {shown.map((declaration, index) => (
        <li key={index} title={declarationStyle[declaration.status].word} className={`rounded border px-1.5 py-0.5 ${declarationStyle[declaration.status].className}`}>
          {declaration.exported && <span className="mr-1 opacity-60">export</span>}
          <span className="font-semibold">{declaration.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The file as its top-level declarations: each one that changed, or whose
 * code is the same but uses code that changed ("affected"), closed by
 * default under a header that says what changed in it and what it uses that
 * changed; opened, its whole code old beside new. Only what runs counts:
 * ones whose change is only to types, comments or formatting aren't shown,
 * nor comments outside the declarations. With `listUnchanged`, the
 * unchanged ones are named on one line. With `neighbors`, each header is a
 * small graph: what it uses that changed, it, and what uses it. With
 * `openAll`, every declaration starts open. Each declaration's id is
 * `<file's id>--<its name>`: a graph's node links there.
 */
function DeclarationsView({
  fileId,
  file,
  declarations,
  listUnchanged,
  neighbors,
  openAll,
}: {
  fileId: string;
  file: AnalyzedFile;
  declarations: Array<AnalyzedDeclaration>;
  listUnchanged: boolean;
  neighbors: boolean;
  openAll: boolean;
}) {
  const unchanged = declarations.filter((declaration) => declaration.status === "unchanged");
  const hidden = (declaration: AnalyzedDeclaration) => declaration.status === "unchanged" || nothingRuns(declaration);

  // The changed lines outside the declarations, each run where it is in the file.
  const items = inFileOrder(declarations, file.outside ?? []);

  return (
    <div>
      {items.map((item, index) =>
        "outside" in item ? (
          item.outside.kind === "comment" ? null : (
          <details key={index} className="group/declaration border-b border-neutral-200 dark:border-neutral-800">
            <summary className="flex cursor-pointer list-none gap-2 px-4 py-3 text-xs hover:bg-neutral-50 dark:hover:bg-neutral-900/60">
              <span className="w-3 shrink-0 select-none pt-0.5 text-neutral-400 transition-transform group-open/declaration:rotate-90">▸</span>
              <span className="min-w-0 flex-1">
                <OutsideTitle run={item.outside} />
              </span>
            </summary>
            {item.outside.rows !== null && (
              <DeclarationRows rows={item.outside.rows} sides={["left", "right"]} tokenKinds={file.tokenKinds} />
            )}
          </details>
          )
        ) : hidden(item.declaration) ? null : (
          <details
            key={index}
            id={`${fileId}--${item.declaration.label}`}
            open={openAll || undefined}
            // Below the sticky graph (if any) and the file's own sticky header.
            className="group/declaration scroll-mt-[calc(var(--files-top,0px)+4rem)] border-b border-neutral-200 dark:border-neutral-800"
          >
            <summary className="flex cursor-pointer list-none gap-2 px-4 py-3 text-xs hover:bg-neutral-50 dark:hover:bg-neutral-900/60">
              <span className="w-3 shrink-0 select-none pt-0.5 text-neutral-400 transition-transform group-open/declaration:rotate-90">▸</span>
              <span className="min-w-0 flex-1">
                {neighbors ? (
                  <MiniGraph file={file} declaration={item.declaration} title={<DeclarationTitle declaration={item.declaration} />} />
                ) : (
                  <>
                    <span className="block">
                      <DeclarationTitle declaration={item.declaration} />
                    </span>
                    <DeclarationSummary declaration={item.declaration} />
                  </>
                )}
              </span>
            </summary>
            <DeclarationRows rows={item.declaration.rows ?? []} sides={sidesOf(item.declaration)} tokenKinds={file.tokenKinds} />
          </details>
        ),
      )}
      {listUnchanged && unchanged.length > 0 && (
        <p className="px-4 py-2 font-mono text-xs text-neutral-500">
          <span className="font-sans">{unchanged.length} unchanged:</span> {unchanged.map((declaration) => declaration.label).join(", ")}
        </p>
      )}
    </div>
  );
}

/** Which sides a declaration has: an added or removed one has only one. */
function sidesOf(declaration: AnalyzedDeclaration): Array<"left" | "right"> {
  return declaration.before === null ? ["right"] : declaration.after === null ? ["left"] : ["left", "right"];
}

function DeclarationTitle({ declaration }: { declaration: AnalyzedDeclaration }) {
  const range = declaration.after ?? declaration.before;
  return (
    <>
      <span className={`mr-2 rounded border px-1.5 py-0.5 font-sans text-[11px] ${declarationStyle[declaration.status].className}`}>{declarationStyle[declaration.status].word}</span>
      {declaration.exported && <span className="mr-1 text-neutral-500">export</span>}
      {declaration.typeOnly && <span className="mr-1 text-indigo-700 dark:text-indigo-300">type</span>}
      <span className="font-mono font-semibold">{declaration.label}</span>
      {range !== null && <span className="ml-2 text-neutral-400">line {range.startLine}</span>}
    </>
  );
}

const outsideStyle: Record<OutsideChange["kind"], { word: string; className: string }> = {
  comment: { word: "comment", className: "border-dashed border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400" },
  moved: { word: "moved", className: "border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-200" },
  other: { word: "other code", className: "border-orange-300 bg-orange-50 text-orange-900 dark:border-orange-800 dark:bg-orange-950/50 dark:text-orange-200" },
};

/** A run of changed lines outside the declarations: what it is, where, and how much. */
function OutsideTitle({ run }: { run: OutsideChange }) {
  // Its lines in the new file; only removed ones: in the old.
  const range = run.after ?? run.before;
  const old = run.after === null ? "old " : "";
  const lines = range === null ? "" : range.startLine === range.endLine ? `${old}line ${range.startLine}` : `${old}lines ${range.startLine}–${range.endLine}`;
  const what =
    run.kind === "comment"
      ? "a comment that belongs to no declaration"
      : run.kind === "moved"
        ? `${run.names.join(", ")}: the same code, which the line diff shows as moved`
        : "code outside any declaration";
  return (
    <>
      <span className="block">
        <span className={`mr-2 rounded border px-1.5 py-0.5 font-sans text-[11px] ${outsideStyle[run.kind].className}`}>{outsideStyle[run.kind].word}</span>
        <span className="text-neutral-500">outside the declarations</span>
        {lines !== "" && <span className="ml-2 text-neutral-400">{lines}</span>}
      </span>
      <span className="mt-1.5 flex flex-wrap gap-x-3 text-neutral-500">
        <span>{what}</span>
        <span>
          +{run.added} −{run.removed} {run.added + run.removed === 1 ? "line" : "lines"}
        </span>
      </span>
    </>
  );
}

/**
 * Under a declaration's title: what changed in its own code, and the
 * top-level code it uses that's new, changed, or uses code that changed.
 */
function DeclarationSummary({ declaration }: { declaration: AnalyzedDeclaration }) {
  const rows = declaration.rows;
  const added = rows?.filter((row) => !row.same && row.right !== null).length ?? 0;
  const removed = rows?.filter((row) => !row.same && row.left !== null).length ?? 0;
  // Each name once, in the order the code first uses it.
  const used = [...new Map(declaration.uses.map((use) => [use.name, use.status])).entries()];

  const own =
    declaration.status === "changed"
      ? rows === null
        ? "its own code changed"
        : `its own code changed: +${added} −${removed} ${added + removed === 1 ? "line" : "lines"}`
      : declaration.status === "affected"
        ? "its own code is the same"
        : declaration.status === "types"
          ? declaration.typeOnly
            ? "a type that changed: nothing that runs did"
            : "only its types changed: nothing that runs did"
          : declaration.status === "comments"
            ? "only its comments changed: nothing that runs did"
            : declaration.status === "formatting"
            ? "only formatting changed: nothing that runs did"
            : declaration.typeOnly
              ? "a type: nothing that runs"
              : null;

  if (own === null && used.length === 0) return null;
  return (
    <span className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-neutral-500">
      {own !== null && <span>{own}</span>}
      {used.length > 0 && (
        <span className="flex flex-wrap items-baseline gap-1">
          <span>uses what changed:</span>
          {used.map(([name, status]) => (
            <span key={name} title={usedStyle[status].title(name)} className={`rounded border px-1.5 font-mono text-[11px] ${usedStyle[status].className}`}>
              {name} <span className="font-sans opacity-70">{usedStyle[status].word}</span>
            </span>
          ))}
        </span>
      )}
      {declaration.status === "affected" && declaration.via.length > 1 && (
        <span>
          through <span className="font-mono">{declaration.via.join(" → ")}</span>
        </span>
      )}
    </span>
  );
}

const usedStyle: Record<UsedChange["status"], { word: string; title: (name: string) => string; className: string }> = {
  added: {
    word: "new",
    title: (name) => `${name} is new`,
    className: "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/50 dark:text-green-200",
  },
  changed: {
    word: "changed",
    title: (name) => `${name}'s own code changed`,
    className: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200",
  },
  affected: {
    word: "affected",
    title: (name) => `${name}'s own code is the same, but it uses code that changed`,
    className: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-200",
  },
};

/**
 * Old and new side by side, every line; an added or removed declaration has
 * one side. Rows are one of four kinds: the same line, a removed one, an
 * added one, and the same line using top-level code that changed ("uses",
 * its names marked).
 */
function DeclarationRows({ rows, sides, tokenKinds }: { rows: Array<DeclarationRow>; sides: Array<"left" | "right">; tokenKinds: Array<string> }) {
  const cells = (row: DeclarationRow) =>
    sides.map((which) => {
      const line = which === "left" ? row.left : row.right;
      const mark = line === null ? null : !row.same ? (which === "left" ? "removed" : "added") : row.uses !== null ? "uses" : null;
      const background = mark === null ? (line === null ? "bg-neutral-50 dark:bg-neutral-900/50" : "") : lineStyle[mark].row;
      // The same line on both sides: the names' places are the same on the old one.
      const changes = mark === "uses" ? (row.uses ?? []).map((use): [number, number] => [use.start, use.end]) : (line?.changes ?? null);
      return [
        <td key={`${which}-number`} className={`w-10 select-none px-2 text-right align-top ${background} ${mark === null ? "text-neutral-400" : lineStyle[mark].number}`}>
          {line?.line}
        </td>,
        <td key={`${which}-text`} className={`whitespace-pre-wrap pr-4 align-top [overflow-wrap:anywhere] ${background} ${which === "left" && sides.length === 2 ? "border-r border-neutral-200 dark:border-neutral-800" : ""}`}>
          {line !== null && <LineText text={line.text} tokens={line.tokens} changes={changes} mark={mark} tokenKinds={tokenKinds} />}
        </td>,
      ];
    });

  /** What a "uses" row's names did: its tooltip. */
  const usesTitle = (row: DeclarationRow) =>
    row.uses === null
      ? undefined
      : [...new Map(row.uses.map((use) => [use.name, use.status])).entries()]
          .map(([name, status]) => (status === "added" ? `${name} is new` : status === "changed" ? `${name} changed` : `${name} uses code that changed`))
          .join("; ");

  const body: Array<ReactNode> = [];
  for (let row = 0; row < rows.length; row++) {
    const current = rows[row];
    if (current !== undefined) {
      body.push(
        <tr key={row} title={usesTitle(current)}>
          {cells(current)}
        </tr>,
      );
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed border-collapse font-mono text-xs leading-5">
        <colgroup>
          {sides.map((which) => [<col key={`${which}-number`} className="w-10" />, <col key={`${which}-text`} />])}
        </colgroup>
        <tbody>{body}</tbody>
      </table>
    </div>
  );
}

const lineStyle = {
  context: { sign: " ", row: "", number: "text-neutral-400" },
  added: { sign: "+", row: "bg-green-50 dark:bg-green-950/40", number: "text-green-700/60 dark:text-green-400/60" },
  removed: { sign: "-", row: "bg-red-50 dark:bg-red-950/40", number: "text-red-700/60 dark:text-red-400/60" },
  uses: { sign: "↳", row: "bg-sky-50 dark:bg-sky-950/30", number: "text-sky-700/60 dark:text-sky-400/60" },
};

const importStyle: Record<ImportChange["status"], { sign: string; className: string }> = {
  added: { sign: "+", className: "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/50 dark:text-green-200" },
  removed: { sign: "−", className: "border-red-300 bg-red-50 text-red-900 line-through dark:border-red-800 dark:bg-red-950/50 dark:text-red-200" },
  changed: { sign: "~", className: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200" },
  unchanged: { sign: "", className: "border-neutral-200 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400" },
};

function ImportList({ imports }: { imports: Array<ImportChange> }) {
  if (imports.length === 0) {
    return <p className="text-xs text-neutral-500">No imports.</p>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5 font-mono text-xs">
      {imports.map((change) => {
        const style = importStyle[change.status];
        return (
          <li key={change.source} title={`${change.status}${change.typeOnly ? ", types only" : ""}`} className={`rounded border px-1.5 py-0.5 ${style.className}`}>
            {style.sign !== "" && <span className="mr-1 select-none">{style.sign}</span>}
            <span className="font-semibold">{change.source}</span>
            {change.typeOnly && <span className="ml-1 opacity-60">type</span>}
            {change.status === "changed" ? (
              <>
                {change.addedBindings.length > 0 && <span className="ml-1 text-green-700 dark:text-green-400">+{change.addedBindings.join(", ")}</span>}
                {change.removedBindings.length > 0 && <span className="ml-1 text-red-700 line-through dark:text-red-400">{change.removedBindings.join(", ")}</span>}
              </>
            ) : (
              change.bindings.length > 0 && <span className="ml-1 opacity-70">{change.bindings.join(", ")}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Short labels for the kinds of export, shown before the name. */
const exportKindLabel: Record<ExportChange["kind"], string> = {
  function: "fn",
  class: "class",
  variable: "const",
  type: "type",
  interface: "interface",
  enum: "enum",
  namespace: "namespace",
  value: "value",
  local: "",
  "re-export": "from",
  commonjs: "cjs",
};

const exportStyle: Record<ExportChange["status"], { sign: string; className: string }> = {
  ...importStyle,
  affected: { sign: "↳", className: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-200" },
};

/** What hovering an export tells: how it changed, and through what. */
function exportTitle(change: ExportChange): string {
  if (change.status === "changed" && change.signatureChanged) {
    return `changed, including its signature\nbefore: ${change.oldSignature ?? "—"}\nafter:  ${change.signature ?? "—"}`;
  }
  if (change.status === "changed") {
    return `changed: its code, not its signature${change.signature === null ? "" : `\n${change.signature}`}`;
  }
  if (change.status === "affected") {
    return `its own code is the same, but it uses code that changed:\n${change.name} → ${change.via.join(" → ")}`;
  }
  return `${change.status}${change.signature === null ? "" : `\n${change.signature}`}`;
}

function ExportList({ exports }: { exports: Array<ExportChange> }) {
  return (
    <ul className="flex flex-wrap gap-1.5 font-mono text-xs">
      {exports.map((change) => {
        const style = exportStyle[change.status];
        const label = exportKindLabel[change.kind];
        return (
          <li key={`${change.status}:${change.name}:${change.signature}`} title={exportTitle(change)} className={`rounded border px-1.5 py-0.5 ${style.className}`}>
            {style.sign !== "" && <span className="mr-1 select-none">{style.sign}</span>}
            {label !== "" && <span className="mr-1 opacity-60">{label}</span>}
            <span className={change.signatureChanged ? "font-semibold underline decoration-wavy" : "font-semibold"}>{change.name}</span>
            {change.kind === "re-export" && change.signature !== null && <span className="ml-1 opacity-60">{change.signature}</span>}
            {change.status === "affected" && <span className="ml-1 opacity-70">via {change.via.join(" → ")}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function UnitList({ units, className }: { units: Array<ChangedUnit>; className: string }) {
  return (
    <ul className="flex flex-wrap gap-1.5 font-mono text-xs">
      {units.map((unit) => (
        <li key={`${unit.line}:${unit.label}`} title={`line ${unit.line}`} className={`rounded border px-1.5 py-0.5 ${className}`}>
          {unit.kind === "import" && <span className="mr-1 opacity-60">import</span>}
          <span className="font-semibold">{unit.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** Colours per highlight capture: the full name first ("function.builtin"), else its first part. */
const tokenStyle: Record<string, string> = {
  keyword: "text-purple-700 dark:text-purple-400",
  string: "text-sky-800 dark:text-sky-300",
  "string.special": "text-sky-700 dark:text-sky-400",
  comment: "text-neutral-500 italic",
  number: "text-blue-700 dark:text-blue-400",
  constant: "text-blue-700 dark:text-blue-400",
  "constant.builtin": "text-blue-700 dark:text-blue-400",
  "variable.builtin": "text-blue-700 dark:text-blue-400",
  function: "text-violet-700 dark:text-violet-300",
  "function.builtin": "text-blue-700 dark:text-blue-400",
  constructor: "text-amber-700 dark:text-amber-300",
  type: "text-amber-700 dark:text-amber-300",
  property: "text-sky-700 dark:text-sky-400",
  tag: "text-teal-700 dark:text-teal-400",
  attribute: "text-indigo-600 dark:text-indigo-300",
  embedded: "text-neutral-700 dark:text-neutral-300",
};

const changedWordStyle = {
  added: "rounded-sm bg-green-200 dark:bg-green-800/70",
  removed: "rounded-sm bg-red-200 dark:bg-red-800/70",
  uses: "rounded-sm bg-sky-200 underline decoration-sky-500 decoration-dotted underline-offset-2 dark:bg-sky-800/70",
};

/**
 * The line's text, cut into its highlighted runs, with the words that
 * changed (`changes`) marked. When the runs don't add up to the text (they
 * come from the file, the text from the diff), it shows unhighlighted
 * rather than wrongly cut.
 */
function LineText({
  text,
  tokens,
  changes,
  mark,
  tokenKinds,
}: {
  text: string;
  tokens: Array<[number, number]> | null;
  changes: Array<[number, number]> | null;
  /** What `changes` marks: words added or removed, or names used whose code changed. */
  mark: "added" | "removed" | "uses" | null;
  tokenKinds: Array<string>;
}) {
  const total = tokens?.reduce((sum, [length]) => sum + length, 0);
  const runs: Array<[number, number]> = tokens !== null && total === text.length ? tokens : [[text.length, -1]];

  // Cut at every run boundary and every change boundary.
  const pieces: Array<{ start: number; end: number; kindIndex: number; changed: boolean }> = [];
  let offset = 0;
  for (const [length, kindIndex] of runs) {
    const end = offset + length;
    let start = offset;
    for (const [changeStart, changeEnd] of mark === null ? [] : (changes ?? [])) {
      if (changeEnd <= start || changeStart >= end) continue;
      if (changeStart > start) pieces.push({ start, end: changeStart, kindIndex, changed: false });
      pieces.push({ start: Math.max(start, changeStart), end: Math.min(end, changeEnd), kindIndex, changed: true });
      start = Math.min(end, changeEnd);
    }
    if (start < end) pieces.push({ start, end, kindIndex, changed: false });
    offset = end;
  }

  return (
    <>
      {pieces.map((piece, index) => {
        const kind = tokenKinds[piece.kindIndex];
        const colour = kind === undefined ? undefined : (tokenStyle[kind] ?? tokenStyle[kind.split(".")[0] ?? ""]);
        const className = [colour, piece.changed && mark !== null ? changedWordStyle[mark] : undefined].filter((name) => name !== undefined).join(" ");
        const part = text.slice(piece.start, piece.end);
        return className === "" ? (
          part
        ) : (
          <span key={index} className={className}>
            {part}
          </span>
        );
      })}
    </>
  );
}

function HunkRows({ hunk, tokenKinds }: { hunk: AnalyzedHunk; tokenKinds: Array<string> }) {
  return (
    <tbody>
      <tr className="bg-blue-50 text-neutral-500 dark:bg-blue-950/30">
        <td colSpan={4} className="px-4 py-1">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@ {hunk.section}
        </td>
      </tr>
      {hunk.lines.map((line, index) => {
        const style = lineStyle[line.kind];
        return (
          <tr key={index} className={style.row}>
            <td className={`w-12 select-none px-2 text-right align-top ${style.number}`}>{line.oldLine}</td>
            <td className={`w-12 select-none px-2 text-right align-top ${style.number}`}>{line.newLine}</td>
            <td className="w-4 select-none align-top">{style.sign}</td>
            <td className="whitespace-pre pr-4">
              <LineText text={line.text} tokens={line.tokens} changes={line.changes} mark={line.kind === "context" ? null : line.kind} tokenKinds={tokenKinds} />
              {line.noNewlineAtEnd && <span className="ml-2 select-none text-neutral-400">⏎̸ no newline at end</span>}
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}
