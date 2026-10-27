import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { branchOf, worktreeOf } from "./worktree.ts";

/**
 * What a research leaves behind. The three are one unit: a ledger kept
 * without its branch points at commits that no longer exist, and a branch
 * kept without its ledger has the next research committing on top of the
 * last one's history.
 */
export type Leftovers = {
  worktree?: string;
  branch?: string;
  ledger?: string;
};

export async function findLeftovers(
  repoRoot: string,
  name: string,
  ledgerDir: string,
): Promise<Leftovers> {
  const worktree = worktreeOf(repoRoot, name);
  const branch = branchOf(name);
  const branches = await simpleGit(repoRoot).branchLocal();
  return {
    ...(existsSync(worktree) ? { worktree } : {}),
    ...(branches.all.includes(branch) ? { branch } : {}),
    ...(await findLedger(ledgerDir, name)),
  };
}

export async function removeLeftovers(repoRoot: string, leftovers: Leftovers): Promise<void> {
  const git = simpleGit(repoRoot);
  if (leftovers.worktree !== undefined) {
    await git.raw(["worktree", "remove", "--force", leftovers.worktree]);
  }
  await git.raw(["worktree", "prune"]);
  if (leftovers.branch !== undefined) {
    await git.raw(["branch", "-D", leftovers.branch]);
  }
  if (leftovers.ledger !== undefined) {
    await rm(leftovers.ledger);
  }
}

/** The ledger is named by id, so it is found by the research name inside it. */
export async function findLedger(dir: string, name: string): Promise<{ ledger?: string }> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return {};
  }
  for (const file of files.filter((one) => one.endsWith(".json"))) {
    const path = join(dir, file);
    const research = JSON.parse(await readFile(path, "utf8")) as { name?: string };
    if (research.name === name) {
      return { ledger: path };
    }
  }
  return {};
}
