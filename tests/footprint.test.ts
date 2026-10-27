import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { expect, test } from "vite-plus/test";
import { confine, footprint, touched } from "../src/footprint.ts";

test("a footprint tells what changed outside the ignored paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "footprint-"));
  try {
    const git = simpleGit(dir);
    await git.init();
    await writeFile(join(dir, ".gitignore"), "scratch/\n");
    await writeFile(join(dir, "kept.ts"), "one\n");
    await writeFile(join(dir, "dirty.ts"), "one\n");
    await git.add(".").addConfig("user.email", "t@t").addConfig("user.name", "t");
    await git.commit("start");
    // Already dirty before the turn: only a further change counts.
    await writeFile(join(dir, "dirty.ts"), "two\n");

    const before = await footprint(dir);
    await writeFile(join(dir, "dirty.ts"), "three\n");
    await writeFile(join(dir, "new.ts"), "stray\n");
    await writeFile(join(dir, "ledger.json"), "{}\n");
    await rm(join(dir, "kept.ts"));
    // Ignored paths are the agent's own room and never show.
    await mkdir(join(dir, "scratch"));
    await writeFile(join(dir, "scratch", "analyse.ts"), "mine\n");
    const after = await footprint(dir);

    expect(touched(before, after, (path) => path === "ledger.json")).toEqual([
      "dirty.ts",
      "kept.ts",
      "new.ts",
    ]);
    expect(touched(after, after)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a confined turn that strays fails, and what it changed is left alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "confine-"));
  try {
    await simpleGit(dir).init();
    await writeFile(join(dir, "ledger.json"), "{}\n");
    const allowed = (path: string) => path === "ledger.json";
    expect(
      await confine(dir, "its cases", allowed, async () => {
        await writeFile(join(dir, "ledger.json"), "{ }\n");
        return "kept to itself";
      }),
    ).toBe("kept to itself");
    await expect(
      confine(dir, "its cases", allowed, async () => {
        await writeFile(join(dir, "stray.ts"), "mine\n");
      }),
    ).rejects.toThrow("The agent changed files outside its cases:\n  stray.ts");
    expect(existsSync(join(dir, "stray.ts"))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
