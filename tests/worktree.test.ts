import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { expect, test } from "vite-plus/test";
import { findLeftovers, removeLeftovers } from "../src/reset.ts";
import { branchOf, ensureWorktree, linkDependencies } from "../src/worktree.ts";

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

test("a worktree resolves packages through the main checkout's", async () => {
  const repo = await initRepo();
  await writeFile(join(repo, ".gitignore"), "node_modules\n");
  await simpleGit(repo).add(".gitignore").commit("ignore packages");
  const path = await ensureWorktree(repo, "gauge");
  await linkDependencies(path, repo);
  // Again, over the link it made.
  await linkDependencies(path, repo);
  expect(await readlink(join(path, "node_modules"))).toBe(join(repo, "node_modules"));
  expect((await simpleGit(path).status()).isClean()).toBe(true);
});

test("a research's leftovers are found together and removed together", async () => {
  const repo = await initRepo();
  const ledgers = join(repo, "researches");
  await mkdir(ledgers);
  await writeFile(join(ledgers, "a1.json"), JSON.stringify({ name: "other" }));
  await writeFile(join(ledgers, "b2.json"), JSON.stringify({ name: "gauge" }));
  expect(await findLeftovers(repo, "gauge", ledgers)).toEqual({ ledger: join(ledgers, "b2.json") });

  const path = await ensureWorktree(repo, "gauge");
  const leftovers = await findLeftovers(repo, "gauge", ledgers);
  expect(leftovers).toEqual({
    worktree: path,
    branch: branchOf("gauge"),
    ledger: join(ledgers, "b2.json"),
  });
  await removeLeftovers(repo, leftovers);
  expect(await findLeftovers(repo, "gauge", ledgers)).toEqual({});
  expect(existsSync(join(ledgers, "a1.json"))).toBe(true);
});
