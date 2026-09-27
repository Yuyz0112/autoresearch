import { spawn } from "node:child_process";
import { extname, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Agent, AgentReply, AgentRequest, TokenUsage } from "../agent.ts";
import { HarnessError } from "../runner.ts";

export type CodexOptions = {
  model?: string;
  timeoutMs?: number;
  sandbox?: "read-only" | "workspace-write";
  /** Extra working directories, e.g. the renderer agent's scratch space. */
  writableDirs?: string[];
  networkAccess?: boolean;
};

/** Fresh, non-interactive turns; authentication stays with the local CLI. */
export function codex(options: CodexOptions = {}): Agent {
  const model = options.model ?? process.env["CODEX_MODEL"] ?? "gpt-6-astra";
  return {
    name: `codex:${model}`,
    async ask(request) {
      const args = [
        "exec",
        "--ephemeral",
        "--json",
        "--color",
        "never",
        "--skip-git-repo-check",
        "--model",
        model,
        "--sandbox",
        options.sandbox ?? "workspace-write",
        "-c",
        'approval_policy="never"',
      ];
      if (options.networkAccess === true && options.sandbox !== "read-only") {
        args.push("-c", "sandbox_workspace_write.network_access=true");
      }
      for (const dir of options.writableDirs ?? []) {
        args.push("--add-dir", dir);
      }
      for (const file of request.attachments ?? []) {
        if (isImage(file)) args.push("--image", resolve(request.cwd, file));
      }
      // The final '-' ends the variadic image option and reads the task from stdin.
      args.push("-");
      return run(args, request, options.timeoutMs ?? 10 * 60 * 1000);
    },
  };
}

function isImage(file: string): boolean {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extname(file).toLowerCase());
}

function run(args: string[], request: AgentRequest, timeoutMs: number): Promise<AgentReply> {
  return new Promise((resolveReply, reject) => {
    const child = spawn("codex", args, {
      cwd: request.cwd,
      detached: process.platform !== "win32",
    });
    // Retain replies and completion records, not command output from an editing turn.
    const events: string[] = [];
    let stderr = "";
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line) as Event;
        if (!event.type.startsWith("item.") || event.item?.type === "agent_message") {
          events.push(line);
        }
      } catch {
        events.push(line);
      }
    });
    const timer = setTimeout(() => {
      // Stop tools spawned by the CLI too; no late writes after a timed-out turn.
      if (child.pid !== undefined) {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          // The process already exited.
        }
      }
      reject(new HarnessError(`codex did not answer within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.stdin.on("error", () => {
      // EPIPE after an early exit is reported by close with the CLI's reason.
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new HarnessError(`codex could not be run: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const raw = events.join("\n");
      try {
        if (code !== 0) {
          throw new HarnessError(
            `codex exited ${String(code)}: ${(raw + "\n" + stderr).slice(-2000)}`,
          );
        }
        resolveReply(parseResult(raw));
      } catch (error) {
        reject(error);
      }
    });
    const files = (request.attachments ?? []).filter((file) => !isImage(file));
    child.stdin.end(
      [
        request.instructions,
        request.prompt,
        ...files.map((file) => `Read attachment: ${resolve(request.cwd, file)}`),
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  });
}

type Event = {
  type: string;
  item?: { type?: string; text?: string };
  error?: { message?: string };
  message?: string;
  usage?: { input_tokens: number; output_tokens: number; cached_input_tokens?: number };
};

/** CLI stdout is JSONL: only a completed turn with an answer is a result. */
export function parseResult(raw: string): AgentReply {
  let text: string | undefined;
  let usage: TokenUsage | undefined;
  let completed = false;
  let failure: string | undefined;
  for (const line of raw.split("\n").filter((one) => one.trim() !== "")) {
    let event: Event;
    try {
      event = JSON.parse(line) as Event;
      if (event === null || typeof event !== "object") throw new Error("not an event");
    } catch {
      throw new HarnessError(`codex did not return JSONL: ${line.slice(0, 200)}`);
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      text = event.item.text;
    }
    if (event.type === "turn.failed") {
      throw new HarnessError(`codex reported an error: ${event.error?.message ?? "turn failed"}`);
    }
    if (event.type === "error") failure = event.message;
    if (event.type === "turn.completed") {
      completed = true;
      if (event.usage !== undefined) {
        usage = {
          input: event.usage.input_tokens,
          output: event.usage.output_tokens,
          ...(event.usage.cached_input_tokens === undefined
            ? {}
            : { cacheRead: event.usage.cached_input_tokens }),
        };
      }
    }
  }
  if (!completed || text === undefined || text.trim() === "") {
    throw new HarnessError(
      `codex returned no completed answer${failure === undefined ? "" : `: ${failure}`}`,
    );
  }
  return { text, ...(usage === undefined ? {} : { usage }) };
}
