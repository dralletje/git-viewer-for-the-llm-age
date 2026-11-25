import { matchesGlob } from "node:path/posix";
import { parse } from "smol-toml";

/**
 * Something that matters in a repository, named in its `.room.toml`: what
 * the changes reach is shown by these first. Like a capability (network,
 * database, ...), but the repository's own: Medplum, the app's database,
 * Twilio. A declaration is in it when its file matches one of `files`, or
 * it's one of `declarations`; using a package that matches one of
 * `packages` reaches it.
 */
export type Point = {
  name: string;
  about: string | null;
  /** Package names, globs: "@medplum/*", "twilio". */
  packages: Array<string>;
  /** Paths from the repository's root, globs: `**` crosses folders. */
  files: Array<string>;
  /** "path#name": one top-level declaration. */
  declarations: Array<string>;
};

/**
 * The points a `.room.toml` names, and what's wrong with it (each problem
 * leaves out the point it's in, or the whole file when it doesn't parse):
 *
 *   [[points]]
 *   name = "Medplum"
 *   about = "The patient record"
 *   packages = ["@medplum/*"]
 */
export function parsePoints(text: string): { points: Array<Point>; problems: Array<string> } {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    return { points: [], problems: [`.room.toml doesn't parse: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const entries = (parsed as { points?: unknown }).points;
  if (entries === undefined) return { points: [], problems: [] };
  if (!Array.isArray(entries)) return { points: [], problems: ["`points` isn't a list of [[points]]."] };

  const points: Array<Point> = [];
  const problems: Array<string> = [];
  entries.forEach((entry: unknown, index) => {
    const point = entry as Record<string, unknown>;
    const strings = (key: string): Array<string> | null => {
      const value = point[key];
      if (value === undefined) return [];
      return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
    };
    const name = point.name;
    const packages = strings("packages");
    const files = strings("files");
    const declarations = strings("declarations");
    if (typeof name !== "string" || name.trim() === "") {
      problems.push(`Point ${index + 1} has no name.`);
    } else if (packages === null || files === null || declarations === null) {
      problems.push(`${name}: packages, files and declarations are each a list of strings.`);
    } else if (packages.length + files.length + declarations.length === 0) {
      problems.push(`${name}: names no packages, files or declarations.`);
    } else {
      points.push({ name, about: typeof point.about === "string" ? point.about : null, packages, files, declarations });
    }
  });
  return { points, problems };
}

/** The point a declaration is in (its file, or itself, is named), or null. */
export function pointOfDeclaration(points: Array<Point>, path: string, label: string): string | null {
  const names = label.split(", ");
  for (const point of points) {
    if (point.files.some((pattern) => matchesGlob(path, pattern))) return point.name;
    if (point.declarations.some((entry) => names.some((name) => entry === `${path}#${name}`))) return point.name;
  }
  return null;
}

/** The point importing from a package reaches, or null: "@medplum/core/x" is the package "@medplum/core". */
export function pointOfPackage(points: Array<Point>, specifier: string): string | null {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
  for (const point of points) {
    if (point.packages.some((pattern) => name === pattern || matchesGlob(name, pattern))) return point.name;
  }
  return null;
}
