import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { FileStorageProvider, InMemoryStorageProvider } from "../src/storage.ts";
import { CheckpointKind, type StorageProvider } from "../src/types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const providers: [string, () => Promise<StorageProvider>][] = [
  ["in-memory", async () => new InMemoryStorageProvider()],
  [
    "file",
    async () =>
      new FileStorageProvider(join(await mkdtemp(join(tmpdir(), "ar-storage-")), "researches")),
  ],
];

describe.each(providers)("%s storage", (_name, create) => {
  test("unknown research is undefined and list is empty", async () => {
    const storage = await create();
    expect(await storage.getResearch("nope")).toBeUndefined();
    expect(await storage.listResearches()).toEqual([]);
  });

  test("createResearch assigns metadata and persists", async () => {
    const storage = await create();
    const research = await storage.createResearch("demo");

    expect(research.id).toMatch(UUID);
    expect(research.createdAt).toBe(research.updatedAt);
    expect(research.checkpoints).toEqual([]);
    expect(await storage.getResearch(research.id)).toEqual(research);
    expect(await storage.listResearches()).toEqual([research.id]);
  });

  test("appendCheckpoint assigns metadata and bumps research", async () => {
    const storage = await create();
    const research = await storage.createResearch("demo");

    const first = await storage.appendCheckpoint(research.id, storage.newCheckpointId(), {
      kind: CheckpointKind.Dummy,
      status: "keep",
      score: { version: "1.0.0", value: 1 },
      metrics: { x: 1 },
    });
    const second = await storage.appendCheckpoint(research.id, storage.newCheckpointId(), {
      kind: CheckpointKind.Dummy,
      status: "crash",
      score: null,
      metrics: {},
      error: "boom",
    });

    expect(first.id).toMatch(UUID);
    expect(first.id).not.toBe(second.id);
    const loaded = await storage.getResearch(research.id);
    expect(loaded?.checkpoints).toEqual([first, second]);
    expect(loaded?.updatedAt).toBe(second.updatedAt);
  });

  test("appendCheckpoint rejects unknown research", async () => {
    const storage = await create();
    await expect(
      storage.appendCheckpoint("nope", storage.newCheckpointId(), {
        kind: CheckpointKind.Dummy,
        status: "keep",
        score: { version: "1.0.0", value: 1 },
        metrics: {},
      }),
    ).rejects.toThrow("Research not found");
  });

  test("loaded copies are detached from storage", async () => {
    const storage = await create();
    const research = await storage.createResearch("demo");
    await storage.appendCheckpoint(research.id, storage.newCheckpointId(), {
      kind: CheckpointKind.Dummy,
      status: "keep",
      score: { version: "1.0.0", value: 1 },
      metrics: {},
    });

    const loaded = await storage.getResearch(research.id);
    loaded!.checkpoints.pop();
    expect((await storage.getResearch(research.id))?.checkpoints).toHaveLength(1);
  });
});

describe.each(providers)("%s storage ids", (_name, create) => {
  test("newCheckpointId is unique and rejects reuse", async () => {
    const storage = await create();
    const research = await storage.createResearch("demo");
    const id = storage.newCheckpointId();
    expect(id).not.toBe(storage.newCheckpointId());

    const data = {
      kind: CheckpointKind.Dummy,
      status: "keep",
      score: { version: "1.0.0", value: 1 },
      metrics: {},
    } as const;
    const checkpoint = await storage.appendCheckpoint(research.id, id, data);
    expect(checkpoint.id).toBe(id);
    await expect(storage.appendCheckpoint(research.id, id, data)).rejects.toThrow(
      "Checkpoint already exists",
    );
  });
});

describe.each(providers)("%s openResearch", (_name, create) => {
  test("creates on first use and returns the same research after", async () => {
    const storage = await create();
    const first = await storage.openResearch("example");
    const again = await storage.openResearch("example");

    expect(again.id).toBe(first.id);
    expect(await storage.listResearches()).toEqual([first.id]);
  });

  test("keeps researches with different names apart", async () => {
    const storage = await create();
    const a = await storage.openResearch("a");
    const b = await storage.openResearch("b");

    expect(a.id).not.toBe(b.id);
  });

  test("sees checkpoints appended since it was opened", async () => {
    const storage = await create();
    const research = await storage.openResearch("example");
    await storage.appendCheckpoint(research.id, storage.newCheckpointId(), {
      kind: CheckpointKind.Dummy,
      status: "keep",
      score: { version: "1.0.0", value: 1 },
      metrics: {},
    });

    expect((await storage.openResearch("example")).checkpoints).toHaveLength(1);
  });
});
