import { existsSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";

const WORKTREE_ROOT = join(".ar", "worktrees");
const BRANCH_PREFIX = "autoresearch/";

/**
 * The checkout a research experiments in: its own branch, its own working
 * tree, under the ignored .ar/. Researches sharing one working tree would
 * sweep up each other's edits, since a checkpoint commit is `git add -A`.
 *
 * Idempotent — an existing worktree for the tag is reused as it stands.
 */
export async function ensureWorktree(repoRoot: string, tag: string): Promise<string> {
  const path = join(repoRoot, WORKTREE_ROOT, tag);
  const git = simpleGit(repoRoot);
  // Drops registrations whose directory was deleted by hand; without it the
  // add below fails on a tag that looks free.
  await git.raw(["worktree", "prune"]);
  if (existsSync(join(path, ".git"))) {
    return path;
  }
  const branch = `${BRANCH_PREFIX}${tag}`;
  const exists = (await git.branchLocal()).all.includes(branch);
  await git.raw(
    exists ? ["worktree", "add", path, branch] : ["worktree", "add", path, "-b", branch],
  );
  return path;
}
