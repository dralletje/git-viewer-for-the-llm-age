import type { Repository } from "@room/git";
import { parsePoints, type Point } from "#/points.ts";
import { readRoomToml } from "#/room-toml.server.ts";

/** The repository's points (see points.ts), from its `.room.toml` as it is now (see `readRoomToml`). */
export async function readPoints(repository: Repository): Promise<{ points: Array<Point>; problems: Array<string> }> {
  const text = await readRoomToml(repository);
  return text === null ? { points: [], problems: [] } : parsePoints(text);
}
