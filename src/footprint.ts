import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";

/**
 * What a checkout's uncommitted state looks like: every path git reports as
 * changed or new, with a digest of its content. Two footprints taken around
 * an agent's turn tell what the turn touched outside the place it was meant
 * to work, which the scope guard cannot see: it watches the research's
 * worktree, and an agent that runs somewhere else can write anywhere.
 *
 * Ignored paths are invisible here by design; that is where an agent is
 * given room of its own.
 */
export type Footprint = Map<string, string>;

export async function footprint(dir: string): Promise<Footprint> {
  const raw = await simpleGit(dir).raw(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const paths = new Set<string>();
  const entries = raw.split("\0");
  for (let at = 0; at < entries.length; at++) {
    const entry = entries[at]!;
    if (entry.length < 4) {
      continue;
    }
    paths.add(entry.slice(3));
    // A rename or copy is followed by the path it came from.
    if (entry[0] === "R" || entry[0] === "C") {
      at++;
    }
  }
  const prints: Footprint = new Map();
  for (const path of paths) {
    prints.set(path, await digest(join(dir, path)));
  }
  return prints;
}

/** Paths whose state differs between two footprints, minus those `allowed` says may change. */
export function touched(
  before: Footprint,
  after: Footprint,
  allowed: (path: string) => boolean = () => false,
): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((path) => before.get(path) !== after.get(path))
    .filter((path) => !allowed(path))
    .sort();
}

async function digest(path: string): Promise<string> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return "missing";
  }
}
