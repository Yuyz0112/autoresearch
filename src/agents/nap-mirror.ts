import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { AgentRequest } from "../agent.ts";
import { HarnessError } from "../runner.ts";
import type { NapClient } from "./nap.ts";

export type MirrorOptions = {
  /**
   * The local checkout. It appears at this same path in the workspace, so
   * every path an instruction, a prompt or a report names is right there too.
   */
  root: string;
  /**
   * What git does not see but the turn needs, relative to root: notes,
   * briefings, a round's state. What git sees is always carried, worktrees
   * and the repository itself included; installed packages never are.
   */
  paths: string[];
  /**
   * Ignored places whose changes come back without being carried in: where
   * a turn writes output the harness reads, like screenshots, that would be
   * too much to send every time.
   */
  returns?: string[];
  /**
   * A command run once the copy is in place, for whatever else the turn's
   * tools need. A turn whose setup fails brings nothing back and fails as the
   * harness's fault, not the agent's.
   */
  setup?: string;
};

export type Mirror = { send(id: string, request: AgentRequest): Promise<Sent> };

type Sent = {
  /** What the agent is told to run before anything else, and why. */
  preamble: string;
  /** Copy the turn's changes back into the local checkout. */
  receive(): Promise<string[]>;
};

/** A carried file as it was packed: what a changed one is told apart by. */
export type Packed = Map<string, { size: number; mtime: number }>;

const BASE = ".nap-mirror";
const TREE = `${BASE}/tree`;
/**
 * Deletions past this many (or a tenth of the copy, if more) are taken for a
 * copy that broke in the workspace — it once came back half wiped, and the
 * harness deleted here what was missing there — rather than an agent's work.
 */
const MAX_REMOVED = 20;
/** Never carried either way: too large to copy, or not the turn's to change. */
const SKIPPED = new Set(["node_modules", ".git"]);

/**
 * The local checkout, carried into a workspace for a turn and back out of it.
 * The workspace's tree is replaced on every turn, so it never drifts from
 * the local one; what comes back is what the turn changed — the files it was
 * given, and any git would show — so the scope guards that watch the local
 * checkout see a cloud turn exactly as they saw a local one.
 */
export function mirrorTo(client: NapClient, options: MirrorOptions): Mirror {
  const root = resolve(options.root);
  return {
    async send(id, request) {
      const cwd = resolve(request.cwd);
      if (isOutside(root, cwd)) {
        throw new HarnessError(`${cwd} is outside the mirrored ${root}`);
      }
      const { packed, archive } = await pack(root, options.paths, attachmentsOf(root, request));
      await client.put(`${BASE}/unpack.sh`, Buffer.from(unpackScript(root, id, options.setup)));
      await client.put(`${BASE}/${id}/tree.tar.gz`, archive);
      return {
        preamble: preambleOf(root, cwd),
        async receive() {
          try {
            await client.get(`${BASE}/${id}/ready`);
          } catch (error) {
            throw new HarnessError(
              "The mirrored checkout was never made ready, so nothing came back: " +
                "the agent did not run the unpack script, or it failed",
              { cause: error },
            );
          }
          const changes = diff(packed, await walk(client, TREE));
          const kept = await keep(
            root,
            [...options.paths, ...(options.returns ?? [])],
            packed,
            changes,
          );
          const removed = kept.filter((path) => changes.removed.includes(path));
          if (removed.length > Math.max(MAX_REMOVED, packed.size / 10)) {
            throw new HarnessError(
              `The copy came back without ${removed.length} of the ${packed.size} files it was ` +
                `given (${removed.slice(0, 3).join(", ")}, …): taken for a broken copy, not ` +
                "the agent's deletions, so nothing came back",
            );
          }
          for (const path of kept) {
            const local = join(root, path);
            if (changes.removed.includes(path)) {
              await rm(local, { force: true });
              continue;
            }
            await mkdir(dirname(local), { recursive: true });
            await writeFile(local, await client.get(`${TREE}/${path}`));
          }
          await client.remove(`${BASE}/${id}`).catch(() => undefined);
          return kept;
        },
      };
    },
  };
}

function preambleOf(root: string, cwd: string): string {
  return [
    `This turn works on a copy of ${root} made for it. Before anything else, run:`,
    "",
    `  bash /workspace/${BASE}/unpack.sh`,
    "",
    "The first time it can take fifteen minutes. Do not go on until it has",
    "printed `mirror ready`; if your tool stops waiting before that, run it",
    "again. If it fails, stop and reply with what it printed. Then work in",
    `${cwd}. What you change under ${root} is copied back when you`,
    "finish; anything outside it stays here.",
  ].join("\n");
}

/**
 * Replaces the workspace's tree with the archive, makes it appear at the
 * local path and runs the setup; only then is the turn marked ready.
 * Installed packages are kept, since installing them again every turn would
 * cost more than the turn. The turn is written in rather than passed: an
 * agent retyping its id has dropped a character of it.
 */
export function unpackScript(root: string, turn: string, setup?: string): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `#!/usr/bin/env bash
# Written by the harness before each mirrored turn.
set -euo pipefail
turn=${quote(turn)}
root=${quote(root)}
base=/workspace/${BASE}
tree=/workspace/${TREE}
archive="$base/$turn/tree.tar.gz"
ready() {
  if [ -e "$base/$turn/ready" ]; then
    echo "mirror ready at $root"
    exit 0
  fi
}
# Run again once this turn's copy is made, it only says so. Run while an
# earlier run is still going — a tool that stopped waiting does not stop
# the command — it waits its turn rather than wiping the tree under it.
ready
exec 9>"$base/lock"
flock 9
ready
mkdir -p "$tree"
find "$tree" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
tar -xzf "$archive" -C "$tree"
# Whatever is missing here would be taken for the agent's deletion.
tar -tzf "$archive" | while IFS= read -r entry; do
  if [ ! -e "$tree/$entry" ] && [ ! -L "$tree/$entry" ]; then
    echo "missing after unpacking: $entry" >&2
    exit 1
  fi
done
if [ "$(readlink "$root" || true)" != "$tree" ]; then
  if [ -e "$root" ] && [ ! -L "$root" ]; then
    echo "$root exists and is not the mirror" >&2
    exit 1
  fi
  sudo mkdir -p "$(dirname "$root")"
  sudo ln -sfn "$tree" "$root"
fi
${setup ?? ""}
touch "$base/$turn/ready"
echo "mirror ready at $root"
`;
}

function attachmentsOf(root: string, request: AgentRequest): string[] {
  return (request.attachments ?? []).map((file) => {
    const path = resolve(request.cwd, file);
    if (isOutside(root, path)) {
      throw new HarnessError(`Attachment ${path} is outside the mirrored ${root}`);
    }
    return relative(root, path);
  });
}

async function pack(
  root: string,
  paths: string[],
  attachments: string[],
): Promise<{ packed: Packed; archive: Buffer }> {
  const candidates = new Set<string>([...(await gitFiles(root)), ...attachments]);
  for (const checkout of await worktrees(root)) {
    const prefix = relative(root, checkout);
    candidates.add(join(prefix, ".git"));
    for (const file of await gitFiles(checkout)) {
      candidates.add(join(prefix, file));
    }
  }
  for (const path of [".git", ...paths]) {
    for (const file of await localFiles(root, path)) {
      candidates.add(file);
    }
  }

  const packed: Packed = new Map();
  const listed: string[] = [];
  for (const path of [...candidates].sort()) {
    const stat = await lstat(join(root, path)).catch(() => undefined);
    if (stat?.isSymbolicLink() === true || (stat?.isFile() === true && isSkipped(path))) {
      // Carried, but not watched: the listing does not follow links, and
      // what is never carried back is not looked at either.
      listed.push(path);
    } else if (stat?.isFile() === true) {
      listed.push(path);
      packed.set(path, { size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000) });
    }
  }

  const scratch = await mkdtemp(join(tmpdir(), "nap-mirror-"));
  try {
    const list = join(scratch, "files");
    const archive = join(scratch, "tree.tar.gz");
    await writeFile(list, listed.join("\n") + "\n");
    // ustar has no room for macOS metadata, which GNU tar would warn about.
    await run("tar", ["--format", "ustar", "-czf", archive, "-C", root, "-T", list], root, {
      COPYFILE_DISABLE: "1",
    });
    return { packed, archive: await readFile(archive) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function gitFiles(checkout: string): Promise<string[]> {
  const out = await run("git", ["ls-files", "-co", "--exclude-standard", "-z"], checkout);
  return out.split("\0").filter((path) => path !== "");
}

/** The worktrees inside the checkout: separate checkouts git does not list from it. */
async function worktrees(root: string): Promise<string[]> {
  const out = await run("git", ["worktree", "list", "--porcelain"], root);
  // Git names them by their real path, which a temporary or linked root is not.
  const real = await realpath(root);
  return out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((path) => path !== real && !isOutside(real, path))
    .map((path) => join(root, relative(real, path)));
}

async function localFiles(root: string, path: string): Promise<string[]> {
  const stat = await lstat(join(root, path)).catch(() => undefined);
  if (stat === undefined) {
    return [];
  }
  if (!stat.isDirectory()) {
    return [path];
  }
  const out: string[] = [];
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === "node_modules") continue;
    out.push(...(await localFiles(root, join(path, entry.name))));
  }
  return out;
}

/** The workspace's tree as files, size and modification time, minus what is never carried. */
export async function walk(client: NapClient, base: string): Promise<Packed> {
  const found: Packed = new Map();
  let pending = [""];
  while (pending.length > 0) {
    const listings = await Promise.all(
      pending.map(async (dir) => ({
        dir,
        entries: await client.list(dir === "" ? base : `${base}/${dir}`),
      })),
    );
    pending = [];
    for (const { dir, entries } of listings) {
      for (const entry of entries) {
        if (SKIPPED.has(entry.name)) continue;
        const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (entry.path_type === "Dir") pending.push(path);
        if (entry.path_type === "File") {
          found.set(path, { size: entry.size, mtime: Math.floor(entry.mtime / 1000) });
        }
      }
    }
  }
  return found;
}

/**
 * What the turn did to the tree. Unpacking keeps each file's time, so one
 * whose time or size moved was written; one that is gone was removed.
 */
export function diff(packed: Packed, remote: Packed): { changed: string[]; removed: string[] } {
  const changed = [...remote]
    .filter(([path, now]) => {
      const was = packed.get(path);
      return was === undefined || was.size !== now.size || was.mtime !== now.mtime;
    })
    .map(([path]) => path);
  const removed = [...packed.keys()].filter((path) => !remote.has(path));
  return { changed: changed.sort(), removed: removed.sort() };
}

/**
 * The changes worth bringing back: to what was carried, to the places the
 * turn was given, and anything new git would show — which is what the scope
 * guards look at. The rest, a tool's output under an ignored directory, say,
 * stays in the workspace and is gone by the next turn.
 */
async function keep(
  root: string,
  paths: string[],
  packed: Packed,
  changes: { changed: string[]; removed: string[] },
): Promise<string[]> {
  const given = (path: string) =>
    packed.has(path) || paths.some((one) => path === one || path.startsWith(`${one}/`));
  const unknown = changes.changed.filter((path) => !given(path));
  const ignored = await ignoredOf(root, unknown);
  return [
    ...changes.changed.filter((path) => given(path) || !ignored.has(path)),
    ...changes.removed,
  ].sort();
}

/** Which of these paths git ignores, each asked of the checkout it is in. */
async function ignoredOf(root: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) {
    return new Set();
  }
  const checkouts = [root, ...(await worktrees(root))].sort((a, b) => b.length - a.length);
  const ignored = new Set<string>();
  for (const checkout of checkouts) {
    const prefix = relative(root, checkout);
    const mine = paths.filter(
      (path) => checkouts.find((one) => !isOutside(one, join(root, path))) === checkout,
    );
    if (mine.length === 0) continue;
    const local = mine.map((path) => (prefix === "" ? path : path.slice(prefix.length + 1)));
    const out = await run("git", ["check-ignore", "-z", "--stdin"], checkout, {}, local, [0, 1]);
    for (const path of out.split("\0").filter((one) => one !== "")) {
      ignored.add(prefix === "" ? path : join(prefix, path));
    }
  }
  return ignored;
}

function isSkipped(path: string): boolean {
  return path.split("/").some((segment) => SKIPPED.has(segment));
}

function isOutside(root: string, path: string): boolean {
  const rel = relative(root, resolve(path));
  return rel.startsWith("..") || resolve(rel) === rel;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  input: string[] = [],
  okCodes = [0],
): Promise<string> {
  return new Promise((resolveOut, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", (error) =>
      reject(new HarnessError(`${command} could not be run: ${error.message}`)),
    );
    child.once("close", (code) => {
      if (okCodes.includes(code ?? -1)) {
        resolveOut(Buffer.concat(out).toString("utf8"));
        return;
      }
      reject(
        new HarnessError(
          `${command} ${args[0] ?? ""} exited ${String(code)}: ${Buffer.concat(err).toString().slice(0, 500)}`,
        ),
      );
    });
    child.stdin.end(input.length === 0 ? "" : `${input.join("\0")}\0`);
  });
}
