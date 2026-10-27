import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { expect, test } from "vite-plus/test";
import { CheckpointManager } from "../src/checkpoint.ts";
import { CheckpointKind } from "../src/types.ts";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-"));
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.name", "test");
  await git.addConfig("user.email", "test@example.com");
  await writeFile(join(dir, "subject.txt"), "v0");
  await git.add("-A");
  await git.commit("init");
  return dir;
}

function gitManager(repo: string): CheckpointManager {
  return new CheckpointManager({ kind: CheckpointKind.Git, repo });
}

test("git checkpoint commits subject and records trailers", async () => {
  const repo = await initRepo();
  const manager = gitManager(repo);

  await writeFile(join(repo, "subject.txt"), "v1");
  const payload = await manager.createPayload({
    id: "cp-keep",
    status: "keep",
    score: { version: "1.0.0", value: 12.5 },
    error: undefined,
  });

  if (payload.kind !== CheckpointKind.Git) throw new Error("expected git kind");
  const git = simpleGit(repo);
  expect((await git.status()).isClean()).toBe(true);
  expect(await git.revparse(["HEAD"])).toBe(payload.commitHash);

  const trailers = await git.raw(["log", "-1", "--format=%(trailers:key=Checkpoint-Id,valueonly)"]);
  expect(trailers.trim()).toBe("cp-keep");
});

test("git checkpoint commits even when subject is unchanged", async () => {
  const repo = await initRepo();
  const manager = gitManager(repo);
  const before = await simpleGit(repo).revparse(["HEAD"]);

  const payload = await manager.createPayload({
    id: "cp-crash",
    status: "crash",
    score: null,
    error: "boom\nstack",
  });

  if (payload.kind !== CheckpointKind.Git) throw new Error("expected git kind");
  expect(payload.commitHash).not.toBe(before);
  const msg = await simpleGit(repo).raw(["log", "-1", "--format=%s%n%b"]);
  expect(msg).toContain("ar: crash");
  expect(msg).toContain("Checkpoint-Id: cp-crash");
  expect(msg).not.toContain("boom");
});

test("revert restores the tree of the previous checkpoint", async () => {
  const repo = await initRepo();
  const manager = gitManager(repo);
  const git = simpleGit(repo);

  await writeFile(join(repo, "subject.txt"), "v1");
  const kept = await manager.createPayload({
    id: "cp-1",
    status: "keep",
    score: { version: "1.0.0", value: 1 },
    error: undefined,
  });
  if (kept.kind !== CheckpointKind.Git) throw new Error("expected git kind");

  await writeFile(join(repo, "subject.txt"), "v2");
  await writeFile(join(repo, "extra.txt"), "junk");
  const discarded = await manager.createPayload({
    id: "cp-2",
    status: "discard",
    score: { version: "1.0.0", value: 0.5 },
    error: undefined,
  });
  if (discarded.kind !== CheckpointKind.Git) {
    throw new Error("expected git kind");
  }

  await manager.revert(discarded);

  expect((await git.status()).isClean()).toBe(true);
  expect(await readFile(join(repo, "subject.txt"), "utf8")).toBe("v1");
  expect(await git.revparse(["HEAD^{tree}"])).toBe(
    await git.revparse([`${kept.commitHash}^{tree}`]),
  );
  expect(await git.revparse(["HEAD^"])).toBe(discarded.commitHash);
  const msg = await git.raw(["log", "-1", "--format=%s%n%b"]);
  expect(msg).toContain(`This reverts commit ${discarded.commitHash}.`);
});

test("revert works for an empty checkpoint commit", async () => {
  const repo = await initRepo();
  const manager = gitManager(repo);
  const before = await simpleGit(repo).revparse(["HEAD^{tree}"]);

  const payload = await manager.createPayload({
    id: "cp-3",
    status: "crash",
    score: null,
    error: "boom",
  });
  await manager.revert(payload);

  expect(await simpleGit(repo).revparse(["HEAD^{tree}"])).toBe(before);
});

test("dummy checkpoint has no side effects", async () => {
  const manager = new CheckpointManager({ kind: CheckpointKind.Dummy });
  const payload = await manager.createPayload({
    id: "cp-4",
    status: "keep",
    score: { version: "1.0.0", value: 1 },
    error: undefined,
  });
  expect(payload).toEqual({ kind: CheckpointKind.Dummy });
  await expect(manager.revert(payload)).resolves.toBeUndefined();
});

async function initScopedRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-scope-"));
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.name", "test");
  await git.addConfig("user.email", "test@example.com");
  await mkdir(join(dir, "subject"), { recursive: true });
  await mkdir(join(dir, "harness"), { recursive: true });
  await writeFile(join(dir, "subject", "render.ts"), "v0");
  await writeFile(join(dir, "harness", "score.ts"), "v0");
  await git.add("-A");
  await git.commit("init");
  return dir;
}

function scopedManager(repo: string): CheckpointManager {
  return new CheckpointManager({
    kind: CheckpointKind.Git,
    repo,
    scope: ["subject"],
  });
}

test("verifyScope accepts changes inside the subject", async () => {
  const repo = await initScopedRepo();
  await writeFile(join(repo, "subject", "render.ts"), "v1");
  await writeFile(join(repo, "subject", "new.ts"), "added");

  await expect(scopedManager(repo).verifyScope()).resolves.toBeUndefined();
});

test("verifyScope rejects changes outside the subject", async () => {
  const repo = await initScopedRepo();
  await writeFile(join(repo, "subject", "render.ts"), "v1");
  await writeFile(join(repo, "harness", "score.ts"), "hacked");
  await writeFile(join(repo, "sneaky.ts"), "untracked");

  await expect(scopedManager(repo).verifyScope()).rejects.toThrow(
    "Changes outside the subject scope: harness/score.ts, sneaky.ts",
  );
});

test("verifyScope reports both ends of a rename", async () => {
  const repo = await initScopedRepo();
  await rename(join(repo, "harness", "score.ts"), join(repo, "harness", "s.ts"));
  await simpleGit(repo).add("-A");

  await expect(scopedManager(repo).verifyScope()).rejects.toThrow("harness/s.ts, harness/score.ts");
});

test("verifyScope is a no-op without a scope", async () => {
  const repo = await initScopedRepo();
  await writeFile(join(repo, "harness", "score.ts"), "hacked");

  await expect(gitManager(repo).verifyScope()).resolves.toBeUndefined();
  await expect(
    new CheckpointManager({ kind: CheckpointKind.Dummy }).verifyScope(),
  ).resolves.toBeUndefined();
});
