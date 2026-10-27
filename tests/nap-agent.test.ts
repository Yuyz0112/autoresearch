import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, expect, test } from "vite-plus/test";
import {
  answerOf,
  isTransient,
  nap,
  NapLostTurn,
  NapTimeout,
  tokensOf,
} from "../src/agents/nap.ts";
import { diff, unpackScript } from "../src/agents/nap-mirror.ts";
import { HarnessError } from "../src/runner.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const text = (value: string) => ({ type: "text", text: value });

test("the answer is the last text of the agent's last message, not its progress notes", () => {
  expect(
    answerOf([
      { role: "user", blocks: [text("do it")] },
      { role: "assistant", blocks: [text("Working…"), { type: "tool_call" }, text("done")] },
    ]),
  ).toBe("done");
  for (const messages of [
    [],
    [{ role: "user", blocks: [text("do it")] }],
    [{ role: "assistant", blocks: [{ type: "tool_call" }] }],
    // Cut off mid-work: the note before the tool call is not an answer.
    [{ role: "assistant", blocks: [text("Still waiting."), { type: "tool_call" }] }],
    [{ role: "assistant", blocks: [text("  ")] }],
  ]) {
    expect(() => answerOf(messages)).toThrow(NapLostTurn);
  }
});

test("usage is read from the session's totals", () => {
  expect(
    tokensOf({
      totals: {
        input_tokens: 100,
        output_tokens: 12,
        cache_read_tokens: 60,
        cache_creation_tokens: 4,
      },
    }),
  ).toEqual({ input: 100, output: 12, cacheRead: 60, cacheWrite: 4 });
  expect(tokensOf({})).toBeUndefined();
});

test("only the platform's failures are worth trying again", () => {
  expect(isTransient(new HarnessError("NAP GET /config failed: fetch failed"))).toBe(true);
  expect(isTransient(new HarnessError("NAP POST /chat returned 503: not running"))).toBe(true);
  expect(isTransient(new HarnessError("NAP POST /chat returned 400: invalid body"))).toBe(false);
  expect(isTransient(new HarnessError("NAP returned no answer (session s)"))).toBe(false);
});

test("a changed, added or removed file is told apart by size and time", () => {
  const packed = new Map([
    ["same", { size: 1, mtime: 10 }],
    ["edited", { size: 1, mtime: 10 }],
    ["gone", { size: 1, mtime: 10 }],
  ]);
  const remote = new Map([
    ["same", { size: 1, mtime: 10 }],
    ["edited", { size: 1, mtime: 99 }],
    ["new", { size: 3, mtime: 99 }],
  ]);
  expect(diff(packed, remote)).toEqual({ changed: ["edited", "new"], removed: ["gone"] });
});

test("the unpack script runs one at a time, and a run after the copy is made only says so", () => {
  const script = unpackScript("/repo", "t1");
  const locked = script.indexOf("flock 9");
  expect(locked).toBeGreaterThan(-1);
  expect(script.lastIndexOf("\nready\n", locked)).toBeGreaterThan(-1);
  expect(script.indexOf("\nready\n", locked)).toBeLessThan(script.indexOf("rm -rf"));
  expect(script.indexOf("tar -tzf")).toBeGreaterThan(script.indexOf("tar -xzf"));
  expect(script.indexOf("tar -tzf")).toBeLessThan(script.indexOf('touch "$base/$turn/ready"'));
});

test("the unpack script quotes the path it links, and is ready only after the setup", () => {
  const script = unpackScript("/home/o'neil/repo", "t1", "bash setup.sh");
  expect(script).toContain(`root='/home/o'\\''neil/repo'`);
  expect(script.indexOf("bash setup.sh")).toBeGreaterThan(script.indexOf("tar -xzf"));
  expect(script.indexOf("bash setup.sh")).toBeLessThan(script.indexOf('touch "$base/$turn/ready"'));
});

test("the unpack script names its turn, so the agent has no id to retype", () => {
  const script = unpackScript("/repo", "mvpnvsx3-u4rup9");
  expect(script).toContain("turn='mvpnvsx3-u4rup9'");
  expect(script).not.toContain("$1");
});

/** The turn the harness wrote into the workspace's unpack script. */
async function turnOf(workspace: string): Promise<string> {
  const script = await readFile(join(workspace, ".nap-mirror", "unpack.sh"), "utf8");
  return /^turn='([^']+)'$/m.exec(script)![1]!;
}

type Call = { method: string; path: string; body?: unknown };

/**
 * A workspace in a directory: files, listings and a chat whose turn is `act`.
 * Enough of NAP's surface to drive the agent end to end without it.
 */
function fakeNap(workspace: string, act: (message: string) => Promise<string>) {
  const calls: Call[] = [];
  const sessions = new Map<string, { status: string; answer?: string }>();
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const path = url.pathname.replace(/^\/api\/workspaces\/ws/, "");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const file = join(workspace, url.searchParams.get("path") ?? "");
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === "/config") return json({ model: "test-model" });
    if (path === "/agent/files" && method === "PUT") {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, Buffer.from(init!.body as Uint8Array));
      return json({ success: true });
    }
    if (path === "/agent/files" && method === "GET") {
      return existsSync(file) ? new Response(await readFile(file)) : json({}, 404);
    }
    if (path === "/agent/files" && method === "DELETE") {
      await rm(file, { recursive: true, force: true });
      return json({ success: true });
    }
    if (path === "/agent/dirs") {
      const entries = await readdir(file, { withFileTypes: true });
      return json({
        entries: await Promise.all(
          entries.map(async (entry) => {
            const info = await stat(join(file, entry.name));
            return {
              name: entry.name,
              path_type: entry.isSymbolicLink() ? "SymLink" : entry.isDirectory() ? "Dir" : "File",
              mtime: info.mtimeMs,
              size: info.size,
            };
          }),
        ),
      });
    }
    if (path === "/chat") {
      const id = `s${sessions.size + 1}`;
      const session: { status: string; answer?: string } = { status: "agent" };
      sessions.set(id, session);
      void act(body.message).then((answer) => {
        session.status = "idle";
        session.answer = answer;
      });
      return json({ session_id: id }, 202);
    }
    const session = sessions.get(path.split("/")[2] ?? url.searchParams.get("session_id") ?? "");
    if (path.startsWith("/sessions/") && path.endsWith("/usage")) {
      return json({
        totals: { input_tokens: 5, output_tokens: 2 },
        settlement: { complete: true },
      });
    }
    if (path.startsWith("/sessions/") && path.endsWith("/interrupt")) return json({});
    if (path.startsWith("/sessions/")) {
      return json({ chat_status: session?.status, pending_agent_calls: 0 });
    }
    if (path === "/messages") {
      const asked = sessions.get(url.searchParams.get("session_id")!);
      return json([
        { role: "user", blocks: [text("task")] },
        ...(asked?.answer === undefined
          ? []
          : [{ role: "assistant", blocks: [text(asked.answer)] }]),
      ]);
    }
    return json({ error: `no route ${method} ${path}` }, 404);
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

test("a turn without a mirror is one new session, its images attached", async () => {
  const dir = await temp("nap-turn-");
  await writeFile(join(dir, "row.png"), "png bytes");
  let sent = "";
  const fake = fakeNap(dir, async (message) => {
    sent = message;
    return '{"ok":true}';
  });
  const agent = await nap({
    workspace: "ws",
    baseUrl: "http://nap",
    token: "t",
    pollMs: 1,
    fetch: fake.fetch,
  });
  expect(agent.name).toBe("nap:test-model");

  const reply = await agent.ask({
    instructions: "You judge.",
    prompt: "Case one.",
    cwd: dir,
    attachments: ["row.png"],
  });
  expect(reply).toEqual({ text: '{"ok":true}', usage: { input: 5, output: 2 } });
  expect(sent).toBe("You judge.\n\nCase one.");
  const chat = fake.calls.find((call) => call.path === "/chat")?.body as Record<string, unknown>;
  expect(chat).toMatchObject({ mode: "async", source: "api" });
  expect(chat["session_id"]).toBeUndefined();
  expect(chat["images"]).toEqual([
    { data: Buffer.from("png bytes").toString("base64"), media_type: "image/png" },
  ]);
});

test("a turn that outlasts its time is interrupted and fails the harness way", async () => {
  const dir = await temp("nap-timeout-");
  const fake = fakeNap(dir, () => new Promise(() => {}));
  const agent = await nap({
    workspace: "ws",
    baseUrl: "http://nap",
    token: "t",
    pollMs: 1,
    timeoutMs: 20,
    fetch: fake.fetch,
  });
  await expect(agent.ask({ instructions: "", prompt: "test", cwd: dir })).rejects.toThrow(
    /did not answer within 20ms/,
  );
  await expect(agent.ask({ instructions: "", prompt: "test", cwd: dir })).rejects.toThrow(
    NapTimeout,
  );
  expect(fake.calls.some((call) => call.path.endsWith("/interrupt"))).toBe(true);
});

test("a read the platform fails mid-restart is asked again", async () => {
  const dir = await temp("nap-500-");
  const fake = fakeNap(dir, async () => "Done.");
  let failures = 1;
  const flaky: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.includes("/sessions/") && failures > 0) {
      failures--;
      return new Response('{"error":"Cannot use a pool after calling end on the pool"}', {
        status: 500,
      });
    }
    return fake.fetch(input, init);
  };
  const agent = await nap({
    workspace: "ws",
    baseUrl: "http://nap",
    token: "t",
    pollMs: 1,
    fetch: flaky,
  });
  // The retry waits its first five seconds for real.
  expect((await agent.ask({ instructions: "", prompt: "Go.", cwd: dir })).text).toBe("Done.");
}, 15_000);

test("a mirrored turn carries the checkout in and what it changed back", async () => {
  const root = await temp("nap-mirror-root-");
  const workspace = await temp("nap-mirror-ws-");
  const git = simpleGit(root);
  await git.init();
  await git.addConfig("user.email", "t@t").addConfig("user.name", "t");
  await writeFile(join(root, ".gitignore"), ".ar/\nnode_modules\n");
  await writeFile(join(root, "kept.ts"), "one\n");
  await writeFile(join(root, "edited.ts"), "one\n");
  await writeFile(join(root, "removed.ts"), "one\n");
  await mkdir(join(root, ".ar", "scratch"), { recursive: true });
  await writeFile(join(root, ".ar", "scratch", "notes.md"), "mine\n");
  // Returned, not carried: the turn starts without it and its output comes back.
  await mkdir(join(root, ".ar", "out"), { recursive: true });
  await writeFile(join(root, ".ar", "out", "old.png"), "stays here\n");
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "installed\n");
  await git.add(".").commit("start");
  await git.raw(["worktree", "add", join(root, ".ar", "worktrees", "r"), "-b", "r"]);
  const worktree = join(root, ".ar", "worktrees", "r");

  let message = "";
  const fake = fakeNap(workspace, async (sent) => {
    message = sent;
    // What the unpack script does, minus the link: the tree is in place.
    const turn = await turnOf(workspace);
    const tree = join(workspace, ".nap-mirror", "tree");
    await mkdir(tree, { recursive: true });
    const unpacked = spawnSync("tar", [
      "-xzf",
      join(workspace, ".nap-mirror", turn, "tree.tar.gz"),
      "-C",
      tree,
    ]);
    expect(unpacked.status).toBe(0);
    await writeFile(join(workspace, ".nap-mirror", turn, "ready"), "");
    expect(existsSync(join(tree, "node_modules"))).toBe(false);
    expect(existsSync(join(tree, ".git", "HEAD"))).toBe(true);
    expect(existsSync(join(tree, ".ar", "worktrees", "r", "kept.ts"))).toBe(true);
    // The turn's work.
    await writeFile(join(tree, "edited.ts"), "two, longer\n");
    await rm(join(tree, "removed.ts"));
    await writeFile(join(tree, "stray.ts"), "new\n");
    await writeFile(join(tree, ".ar", "scratch", "more.md"), "kept\n");
    expect(existsSync(join(tree, ".ar", "out", "old.png"))).toBe(false);
    await mkdir(join(tree, ".ar", "out"), { recursive: true });
    await writeFile(join(tree, ".ar", "out", "new.png"), "came back\n");
    await mkdir(join(tree, ".ar", "shots"), { recursive: true });
    await writeFile(join(tree, ".ar", "shots", "row.png"), "left behind\n");
    await writeFile(join(tree, ".ar", "worktrees", "r", "case.json"), "{}\n");
    return "Done.";
  });
  const agent = await nap({
    workspace: "ws",
    baseUrl: "http://nap",
    token: "t",
    pollMs: 1,
    fetch: fake.fetch,
    mirror: { root, paths: [".ar/scratch"], returns: [".ar/out"], setup: "bash setup.sh" },
  });

  const reply = await agent.ask({ instructions: "Edit.", prompt: "Go.", cwd: worktree });
  expect(reply.text).toBe("Done.");
  expect(message).toContain(`copy of ${root}`);
  expect(message).toContain("bash /workspace/.nap-mirror/unpack.sh\n");
  expect(message).toContain(`work in\n${worktree}.`);

  expect(await readFile(join(root, "edited.ts"), "utf8")).toBe("two, longer\n");
  expect(existsSync(join(root, "removed.ts"))).toBe(false);
  expect(await readFile(join(root, "stray.ts"), "utf8")).toBe("new\n");
  expect(await readFile(join(root, ".ar", "scratch", "more.md"), "utf8")).toBe("kept\n");
  expect(await readFile(join(worktree, "case.json"), "utf8")).toBe("{}\n");
  expect(await readFile(join(root, ".ar", "out", "new.png"), "utf8")).toBe("came back\n");
  expect(await readFile(join(root, ".ar", "out", "old.png"), "utf8")).toBe("stays here\n");
  // Ignored and not the turn's to keep.
  expect(existsSync(join(root, ".ar", "shots"))).toBe(false);
  // Never carried, so never touched.
  expect(await readFile(join(root, "node_modules", "pkg", "index.js"), "utf8")).toBe("installed\n");
  expect(existsSync(join(worktree, ".git"))).toBe(true);
  expect(await readFile(join(root, "kept.ts"), "utf8")).toBe("one\n");
  // The turn's inbox is cleared.
  expect(await readdir(join(workspace, ".nap-mirror"))).toEqual(["tree", "unpack.sh"]);
});

test("a mirrored turn whose agent never unpacked brings nothing back", async () => {
  const root = await temp("nap-mirror-skip-");
  const workspace = await temp("nap-mirror-skip-ws-");
  await simpleGit(root).init();
  await writeFile(join(root, "kept.ts"), "one\n");
  const fake = fakeNap(workspace, async () => "I did it my way.");
  const agent = await nap({
    workspace: "ws",
    baseUrl: "http://nap",
    token: "t",
    pollMs: 1,
    fetch: fake.fetch,
    mirror: { root, paths: [] },
  });
  await expect(agent.ask({ instructions: "", prompt: "Go.", cwd: root })).rejects.toThrow(
    /never made ready/,
  );
  expect(await readFile(join(root, "kept.ts"), "utf8")).toBe("one\n");
});

test("a copy that comes back half wiped is taken for broken, and nothing comes back", async () => {
  const root = await temp("nap-mirror-wiped-");
  const workspace = await temp("nap-mirror-wiped-ws-");
  await simpleGit(root).init();
  for (let n = 0; n < 30; n++) {
    await writeFile(join(root, `file${n}.ts`), "one\n");
  }
  const fake = fakeNap(workspace, async () => {
    const turn = await turnOf(workspace);
    const tree = join(workspace, ".nap-mirror", "tree");
    await mkdir(tree, { recursive: true });
    spawnSync("tar", ["-xzf", join(workspace, ".nap-mirror", turn, "tree.tar.gz"), "-C", tree]);
    await writeFile(join(workspace, ".nap-mirror", turn, "ready"), "");
    // A second unpack wiping the tree under the first.
    for (let n = 0; n < 25; n++) {
      await rm(join(tree, `file${n}.ts`));
    }
    await writeFile(join(tree, "file29.ts"), "two\n");
    return "Done.";
  });
  const agent = await nap({
    workspace: "ws",
    baseUrl: "http://nap",
    token: "t",
    pollMs: 1,
    fetch: fake.fetch,
    mirror: { root, paths: [] },
  });
  await expect(agent.ask({ instructions: "", prompt: "Go.", cwd: root })).rejects.toThrow(
    /without 25 of the 30 files/,
  );
  expect(await readFile(join(root, "file0.ts"), "utf8")).toBe("one\n");
  expect(await readFile(join(root, "file29.ts"), "utf8")).toBe("one\n");
});
