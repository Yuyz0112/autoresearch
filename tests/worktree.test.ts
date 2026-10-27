import { rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { expect, test } from "vite-plus/test";
import { ensureWorktree } from "../src/worktree.ts";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-wt-"));
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.name", "test");
  await git.addConfig("user.email", "test@example.com");
  await writeFile(join(dir, "subject.txt"), "v0");
  await git.add("-A");
  await git.commit("init");
  return dir;
}

test("creates a worktree on its own branch", async () => {
  const repo = await initRepo();
  const path = await ensureWorktree(repo, "gauge");

  expect(path).toBe(join(repo, ".ar", "worktrees", "gauge"));
  expect(await simpleGit(path).revparse(["--abbrev-ref", "HEAD"])).toBe("autoresearch/gauge");
  expect((await simpleGit(path).status()).isClean()).toBe(true);
});

test("reuses an existing worktree without touching its state", async () => {
  const repo = await initRepo();
  const path = await ensureWorktree(repo, "gauge");
  await writeFile(join(path, "subject.txt"), "in progress");

  expect(await ensureWorktree(repo, "gauge")).toBe(path);
  expect((await simpleGit(path).status()).modified).toEqual(["subject.txt"]);
});

test("keeps two researches on separate branches and trees", async () => {
  const repo = await initRepo();
  const a = await ensureWorktree(repo, "gauge");
  const b = await ensureWorktree(repo, "timeseries");

  await writeFile(join(a, "subject.txt"), "a");
  await simpleGit(a).add("-A");
  await simpleGit(a).commit("a");

  // b's tree and history are untouched by a's checkpoint.
  expect((await simpleGit(b).status()).isClean()).toBe(true);
  expect(await simpleGit(b).revparse(["HEAD"])).toBe(await simpleGit(repo).revparse(["HEAD"]));
});

test("recovers a worktree whose directory was deleted by hand", async () => {
  const repo = await initRepo();
  const path = await ensureWorktree(repo, "gauge");
  await rm(path, { recursive: true });

  expect(await ensureWorktree(repo, "gauge")).toBe(path);
  expect(await simpleGit(path).revparse(["--abbrev-ref", "HEAD"])).toBe("autoresearch/gauge");
});
