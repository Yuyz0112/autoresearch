import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { expect, test } from "vite-plus/test";
import { footprint, touched } from "../src/footprint.ts";

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
