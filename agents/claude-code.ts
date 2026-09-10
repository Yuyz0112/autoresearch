import { spawn } from "node:child_process";
import type { Agent, AgentReply, AgentRequest, TokenUsage } from "../agent.ts";
import { HarnessError } from "../runner.ts";

export type ClaudeCodeOptions = {
  model?: string;
  /** A turn that never returns would stall the loop rather than fail it. */
  timeoutMs?: number;
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
      const raw = await run(args, request, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      return parse(raw);
    },
  };
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
      reject(new HarnessError(`claude exited ${String(code)}: ${Buffer.concat(err).toString()}`));
    });

    child.stdin.end(request.prompt);
  });
}

type Result = {
  result?: string;
  is_error?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

function parse(raw: string): AgentReply {
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

function usageOf(result: Result): TokenUsage | undefined {
  const usage = result.usage;
  if (usage === undefined) {
    return undefined;
  }
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    ...(usage.cache_read_input_tokens === undefined
      ? {}
      : { cacheRead: usage.cache_read_input_tokens }),
    ...(usage.cache_creation_input_tokens === undefined
      ? {}
      : { cacheWrite: usage.cache_creation_input_tokens }),
  };
}
