import { spawn } from "node:child_process";
import type { Agent, AgentReply, AgentRequest, TokenUsage } from "../agent.ts";
import { HarnessError } from "../runner.ts";

export type ClaudeCodeOptions = {
  model?: string;
  /** A turn that never returns would stall the loop rather than fail it. */
  timeoutMs?: number;
  /**
   * Tools the agent may use, e.g. `["Read", "Bash(pnpm run case-gen:write*)"]`.
   * Anything else is denied outright rather than left waiting for an answer
   * nobody is there to give. Unset allows everything, which is what the scope
   * guard and the revert exist to make survivable.
   */
  allowedTools?: string[];
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The local CLI in print mode. Every call is a fresh session — no resume, no
 * continue — so turns cannot see each other, which is the isolation the loop
 * depends on.
 */
export function claudeCode(options: ClaudeCodeOptions = {}): Agent {
  return {
    name: `claude-code${options.model === undefined ? "" : `:${options.model}`}`,
    async ask(request: AgentRequest): Promise<AgentReply> {
      const args = ["-p", "--output-format", "json", "--system-prompt", request.instructions];
      if (options.model !== undefined) {
        args.push("--model", options.model);
      }
      if (options.allowedTools === undefined) {
        args.push("--permission-mode", "bypassPermissions");
      } else {
        args.push("--allowedTools", ...options.allowedTools, "--permission-prompts", "none");
      }
      for (let attempt = 1; ; attempt++) {
        try {
          const raw = await run(args, request, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
          return parseResult(raw);
        } catch (error) {
          const wait = RETRY_WAITS_MS[attempt - 1];
          if (
            wait === undefined ||
            !(error instanceof HarnessError) ||
            !isTransient(error.message)
          ) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    },
  };
}

/**
 * How long to wait before each retry of a turn the connection dropped.
 * A dropped connection says nothing about the work, and one used to end a
 * whole run, throwing away a measurement that took a quarter of an hour.
 * A retried turn is a fresh session that finds the files as the lost one
 * left them, which is what a new turn would find anyway.
 */
const RETRY_WAITS_MS = [30_000, 120_000];

/** Whether a failure was the API's rather than the agent's: worth trying again. */
export function isTransient(message: string): boolean {
  return /"terminal_reason":"api_error"|API Error: (Connection|Overloaded|5\d\d|Request timed out)/i.test(
    message,
  );
}

function run(args: string[], request: AgentRequest, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: request.cwd });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new HarnessError(`claude did not answer within ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new HarnessError(`claude could not be run: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(out).toString("utf8"));
        return;
      }
      // With --output-format json the reason is usually on stdout, not stderr.
      const said = [Buffer.concat(err).toString(), Buffer.concat(out).toString()]
        .map((text) => text.trim())
        .filter((text) => text !== "")
        .join("\n")
        .slice(0, 2000);
      reject(new HarnessError(`claude exited ${String(code)}: ${said}`));
    });

    child.stdin.end(promptOf(request));
  });
}

/**
 * The prompt as sent. The CLI reads files with its own tools, so attachments
 * are named for it to open rather than sent along.
 */
export function promptOf(request: AgentRequest): string {
  const attachments = request.attachments ?? [];
  if (attachments.length === 0) {
    return request.prompt;
  }
  return [
    request.prompt,
    "",
    "Attached — read each of these before answering:",
    ...attachments.map((path) => `  ${path}`),
  ].join("\n");
}

export type Result = {
  result?: string;
  is_error?: boolean;
  /** Per model, and the only figure that survives a turn delegating to subagents. */
  modelUsage?: Record<string, ModelUsage>;
};

type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

export function parseResult(raw: string): AgentReply {
  let result: Result;
  try {
    result = JSON.parse(raw) as Result;
  } catch {
    throw new HarnessError(`claude did not return JSON: ${raw.slice(0, 200)}`);
  }
  if (result.is_error === true || result.result === undefined) {
    throw new HarnessError(`claude reported an error: ${raw.slice(0, 200)}`);
  }
  return { text: result.result, usage: usageOf(result) };
}

/**
 * Summed over models rather than read from `usage`, which reports the last
 * exchange: a turn that delegates to subagents does most of its work outside
 * it, and reported a couple of hundred tokens for an hour of writing.
 */
function usageOf(result: Result): TokenUsage | undefined {
  const models = Object.values(result.modelUsage ?? {});
  if (models.length === 0) {
    return undefined;
  }
  return models.reduce<TokenUsage>(
    (total, model) => ({
      input: total.input + (model.inputTokens ?? 0),
      output: total.output + (model.outputTokens ?? 0),
      cacheRead: (total.cacheRead ?? 0) + (model.cacheReadInputTokens ?? 0),
      cacheWrite: (total.cacheWrite ?? 0) + (model.cacheCreationInputTokens ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
}
