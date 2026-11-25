import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The top of every changes page: what the changes are (a commit's subject,
 * "What feature changed since main", ...), a description that shows two
 * lines until expanded, a row of details (author, date, counts, links), and
 * notes below them (a merge, nothing to compare, ...).
 */
export function ChangesHeader({
  title,
  description,
  details,
  children,
}: {
  title: ReactNode;
  /** Text, as written (a commit message's body): its line breaks are kept. */
  description?: string | null;
  /** Each its own item in the row; null ones are left out. */
  details: Array<ReactNode>;
  children?: ReactNode;
}) {
  const shown = details.filter((detail) => detail !== null && detail !== false);
  return (
    <header className="mb-4">
      <h2 className="text-xl font-semibold">{title}</h2>
      {description !== undefined && description !== null && description !== "" && <Description key={description} text={description} />}
      {shown.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-500">
          {shown.map((detail, index) => (
            <li key={index}>{detail}</li>
          ))}
        </ul>
      )}
      {children}
    </header>
  );
}

/**
 * Two lines of the text until expanded: the tabs and the changes stay near
 * the top. "Show more" only when there is more.
 */
function Description({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const element = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const current = element.current;
    if (current === null) return;
    const measure = () => setOverflows(current.scrollHeight > current.clientHeight + 1);
    measure();
    // A narrower window wraps more lines.
    const observer = new ResizeObserver(measure);
    observer.observe(current);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="mt-2">
      <pre ref={element} className={`whitespace-pre-wrap font-sans text-sm text-neutral-600 dark:text-neutral-400 ${expanded ? "" : "line-clamp-2"}`}>
        {/* Collapsed, the blank lines between paragraphs would take up the two lines. */}
        {expanded ? text : text.replace(/\n\s*\n/g, "\n")}
      </pre>
      {(overflows || expanded) && (
        <button type="button" onClick={() => setExpanded(!expanded)} className="mt-0.5 text-xs text-blue-700 hover:underline dark:text-blue-400">
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** A branch or ref name in a title: set apart as code. */
export function RefName({ children }: { children: ReactNode }) {
  return <code className="rounded bg-neutral-100 px-1.5 font-mono text-lg dark:bg-neutral-800">{children}</code>;
}
