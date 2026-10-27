import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { expect, test } from "vite-plus/test";
import { HarnessError, ResearchRunner } from "../src/runner.ts";
import { InMemoryStorageProvider } from "../src/storage.ts";
import { CheckpointKind, type ResearchOptions } from "../src/types.ts";

type Metrics = { v: number };

const SCORE_VERSION = "1.0.0";

function options(
  storage: InMemoryStorageProvider,
  results: (number | Error)[],
): ResearchOptions<Metrics> {
  let i = 0;
  return {
    name: "demo",
    checkpointOptions: { kind: CheckpointKind.Dummy },
    storageProvider: storage,
    doResearch: async () => {
      const r = results[i++];
      if (r instanceof Error) throw r;
      return { v: r ?? 0 };
    },
    doScore: async (m) => ({ version: SCORE_VERSION, value: m.v }),
  };
}

test("keeps improvements, discards regressions, records crashes", async () => {
  const storage = new InMemoryStorageProvider();
  const runner = await ResearchRunner.create(options(storage, [1, 0.5, 2, new Error("boom")]));

  for (let n = 0; n < 4; n++) await runner.run();

  const research = await storage.getResearch(runner.research.id);
  const checkpoints = research?.checkpoints ?? [];
  expect(checkpoints.map((c) => c.status)).toEqual(["keep", "discard", "keep", "crash"]);
  expect(checkpoints.map((c) => c.score?.value ?? null)).toEqual([1, 0.5, 2, null]);
  expect(checkpoints[3]?.error).toBe("boom");
  expect(runner.research).toEqual(research);
});

test("resume continues against the persisted best", async () => {
  const storage = new InMemoryStorageProvider();
  const first = await ResearchRunner.create(options(storage, [1]));
  await first.run();

  const resumed = await ResearchRunner.resume(options(storage, [1, 3]), first.research.id);
  await resumed.run();
  await resumed.run();

  const research = await storage.getResearch(first.research.id);
  expect(research?.checkpoints.map((c) => c.status)).toEqual(["keep", "discard", "keep"]);
});

test("a zero baseline is kept, but a tie or regression against it is discarded", async () => {
  const storage = new InMemoryStorageProvider();
  const runner = await ResearchRunner.create(options(storage, [0, 0, -1, 1]));
  for (let n = 0; n < 4; n++) await runner.run();
  expect(runner.research.checkpoints.map((one) => one.status)).toEqual([
    "keep",
    "discard",
    "discard",
    "keep",
  ]);
});

test("resume rejects unknown research", async () => {
  const storage = new InMemoryStorageProvider();
  await expect(ResearchRunner.resume(options(storage, []), "nope")).rejects.toThrow(
    "Research not found",
  );
});

test("a change outside the subject scope crashes and is reverted", async () => {
  const repo = await mkdtemp(join(tmpdir(), "ar-runner-"));
  const git = simpleGit(repo);
  await git.init();
  await git.addConfig("user.name", "test");
  await git.addConfig("user.email", "test@example.com");
  await mkdir(join(repo, "subject"), { recursive: true });
  await writeFile(join(repo, "subject", "render.ts"), "v0");
  await writeFile(join(repo, "harness.ts"), "v0");
  await git.add("-A");
  await git.commit("init");
  const baseTree = await git.revparse(["HEAD^{tree}"]);

  const storage = new InMemoryStorageProvider();
  let researched = false;
  const runner = await ResearchRunner.create<Metrics>({
    name: "demo",
    checkpointOptions: {
      kind: CheckpointKind.Git,
      repo,
      scope: ["subject"],
    },
    storageProvider: storage,
    doResearch: async () => {
      researched = true;
      return { v: 1 };
    },
    doScore: async (m) => ({ version: SCORE_VERSION, value: m.v }),
  });

  await writeFile(join(repo, "harness.ts"), "hacked");
  await runner.run();

  expect(researched).toBe(false);
  const checkpoints = runner.research.checkpoints;
  expect(checkpoints.map((c) => c.status)).toEqual(["crash"]);
  expect(checkpoints[0]?.error).toContain("harness.ts");
  expect(await git.revparse(["HEAD^{tree}"])).toBe(baseTree);
});

test("scores from another score version are not comparable", async () => {
  const storage = new InMemoryStorageProvider();
  const v1 = await ResearchRunner.create(options(storage, [5]));
  await v1.run();

  const base = options(storage, [1, 0.5]);
  const v2 = await ResearchRunner.resume(
    { ...base, doScore: async (m) => ({ version: "2.0.0", value: m.v }) },
    v1.research.id,
  );
  await v2.run();
  await v2.run();

  const research = await storage.getResearch(v1.research.id);
  expect(research?.checkpoints.map((c) => c.status)).toEqual(["keep", "keep", "discard"]);
});

async function gitOptions(
  storage: InMemoryStorageProvider,
  repo: string,
): Promise<ResearchOptions<Metrics>> {
  return { ...options(storage, [1, 2, 3]), checkpointOptions: { kind: CheckpointKind.Git, repo } };
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-runner-"));
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.name", "test");
  await git.addConfig("user.email", "test@example.com");
  await writeFile(join(dir, "subject.txt"), "v0");
  await git.add("-A");
  await git.commit("init");
  return dir;
}

test("refuses to continue a research in a different repo", async () => {
  const storage = new InMemoryStorageProvider();
  const first = await initRepo();
  const runner = await ResearchRunner.open(await gitOptions(storage, first));
  await runner.run();

  const second = await initRepo();
  await expect(ResearchRunner.open(await gitOptions(storage, second))).rejects.toThrow(
    `is checkpointed in ${first}, not ${second}`,
  );
  await expect(
    ResearchRunner.resume(await gitOptions(storage, second), runner.research.id),
  ).rejects.toThrow("is checkpointed in");
});

test("accepts the repo its checkpoints were made in", async () => {
  const storage = new InMemoryStorageProvider();
  const repo = await initRepo();
  const runner = await ResearchRunner.open(await gitOptions(storage, repo));
  await runner.run();

  const reopened = await ResearchRunner.open(await gitOptions(storage, repo));
  expect(reopened.research.checkpoints).toHaveLength(1);
});

test("a research with no git checkpoints yet pins to nothing", async () => {
  const storage = new InMemoryStorageProvider();
  await storage.openResearch("demo");

  await expect(
    ResearchRunner.open(await gitOptions(storage, await initRepo())),
  ).resolves.toBeDefined();
});

test("a harness failure leaves no checkpoint and no revert", async () => {
  const storage = new InMemoryStorageProvider();
  const repo = await initRepo();
  const failing: ResearchOptions<Metrics> = {
    ...(await gitOptions(storage, repo)),
    doResearch: async () => {
      throw new HarnessError("grafana is down");
    },
  };

  const runner = await ResearchRunner.open(failing);
  const before = await simpleGit(repo).revparse(["HEAD"]);

  await expect(runner.run()).rejects.toThrow("grafana is down");

  const research = await storage.getResearch(runner.research.id);
  expect(research?.checkpoints).toHaveLength(0);
  expect(await simpleGit(repo).revparse(["HEAD"])).toBe(before);
});

test("an ordinary failure still crashes and reverts", async () => {
  const storage = new InMemoryStorageProvider();
  const repo = await initRepo();
  const failing: ResearchOptions<Metrics> = {
    ...(await gitOptions(storage, repo)),
    doResearch: async () => {
      throw new Error("the case is malformed");
    },
  };

  const runner = await ResearchRunner.open(failing);
  await runner.run();

  const research = await storage.getResearch(runner.research.id);
  expect(research?.checkpoints.map((c) => c.status)).toEqual(["crash"]);
});
