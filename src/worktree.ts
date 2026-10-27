import { existsSync } from "node:fs";
import { lstat, symlink } from "node:fs/promises";
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
  const path = worktreeOf(repoRoot, tag);
  const git = simpleGit(repoRoot);
  // Drops registrations whose directory was deleted by hand; without it the
  // add below fails on a tag that looks free.
  await git.raw(["worktree", "prune"]);
  if (existsSync(join(path, ".git"))) {
    return path;
  }
  const branch = branchOf(tag);
  const exists = (await git.branchLocal()).all.includes(branch);
  await git.raw(
    exists ? ["worktree", "add", path, branch] : ["worktree", "add", path, "-b", branch],
  );
  return path;
}

/** Where the research tagged so experiments, whether or not it exists yet. */
export function worktreeOf(repoRoot: string, tag: string): string {
  return join(repoRoot, WORKTREE_ROOT, tag);
}

/** The branch its kept experiments are committed on. */
export function branchOf(tag: string): string {
  return `${BRANCH_PREFIX}${tag}`;
}

/**
 * A worktree is a checkout without the installed packages. Whatever runs in
 * it resolves modules by walking up, so the main checkout's are linked in;
 * node_modules is ignored, so the link is never committed.
 */
export async function linkDependencies(worktree: string, repoRoot: string): Promise<void> {
  const link = join(worktree, "node_modules");
  const exists = await lstat(link).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await symlink(join(repoRoot, "node_modules"), link, "dir");
  }
}
