import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { Agent, AgentReply, AgentRequest, TokenUsage } from "../agent.ts";
import { HarnessError } from "../runner.ts";
import { type Mirror, type MirrorOptions, mirrorTo } from "./nap-mirror.ts";

export type NapOptions = {
  /** The workspace whose agent answers. Its model is whatever NAP has it set to. */
  workspace: string;
  /** Defaults to NAP_BASE_URL. */
  baseUrl?: string;
  /** Defaults to NAP_TOKEN. */
  token?: string;
  /** A turn that never returns would stall the loop rather than fail it. */
  timeoutMs?: number;
  /** How often a running turn is looked at. */
  pollMs?: number;
  /**
   * A local checkout the cloud agent works on as if it were local: copied in
   * before the turn, changes copied back after. Without one the agent only
   * sees what the request carries.
   */
  mirror?: MirrorOptions;
  /** For tests. */
  fetch?: typeof fetch;
};

/** The workspace an environment variable names; each role has its own, with its own model. */
export function workspaceFrom(variable: string): string {
  const workspace = process.env[variable];
  if (workspace === undefined || workspace === "") {
    throw new HarnessError(`${variable} has to name the NAP workspace to use`);
  }
  return workspace;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * A NAP cloud agent. Every call is a new session in the same workspace, so
 * turns cannot see each other's conversation, which is the isolation the loop
 * depends on. The workspace's files do persist; a mirrored turn replaces
 * them with the local checkout first.
 *
 * Asynchronous because it asks the workspace which model it runs: that is
 * the agent's name, recorded with what it produced, and a workspace that
 * cannot be reached is better found before a run than an hour into it.
 */
export async function nap(options: NapOptions): Promise<Agent> {
  const client = napClient(options);
  const config = (await client.json("GET", `/config`)) as { model?: string };
  const mirror = options.mirror === undefined ? undefined : mirrorTo(client, options.mirror);
  // A mirror is one tree in the workspace: two turns at once would unpack over each other.
  let queue: Promise<unknown> = Promise.resolve();
  const agent: Agent = {
    name: `nap:${config.model ?? options.workspace}`,
    ask(request) {
      if (mirror === undefined) {
        return turn(client, options, request);
      }
      const next = queue.then(() => turn(client, options, request, mirror));
      queue = next.catch(() => undefined);
      return next;
    },
  };
  return agent;
}

async function turn(
  client: NapClient,
  options: NapOptions,
  request: AgentRequest,
  mirror?: Mirror,
): Promise<AgentReply> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const sent = mirror === undefined ? undefined : await mirror.send(id, request);
  const { message, images } = await messageOf(client, id, request, sent?.preamble);
  const started = (await client.json("POST", "/chat", {
    message,
    ...(images.length === 0 ? {} : { images }),
    mode: "async",
    source: "api",
  })) as { session_id?: string };
  const session = started.session_id;
  if (session === undefined) {
    throw new HarnessError(`NAP started no session in ${options.workspace}`);
  }
  const text = await awaitAnswer(client, session, options);
  const usage = await usageOf(client, session, options.pollMs);
  if (sent !== undefined) {
    await sent.receive();
  }
  return { text, ...(usage === undefined ? {} : { usage }) };
}

/**
 * The message as sent: the standing instructions travel with every turn,
 * since the session starts empty. Images are attached; other files, when
 * nothing mirrors them, are put in the workspace and named.
 */
async function messageOf(
  client: NapClient,
  id: string,
  request: AgentRequest,
  preamble: string | undefined,
): Promise<{ message: string; images: { data: string; media_type: string }[] }> {
  const images: { data: string; media_type: string }[] = [];
  const named: string[] = [];
  for (const file of request.attachments ?? []) {
    const path = resolve(request.cwd, file);
    if (preamble !== undefined) {
      // Mirrored at the same path; the prompt already says where.
      continue;
    }
    const type = IMAGE_TYPES[extname(path).toLowerCase()];
    if (type !== undefined) {
      images.push({ data: (await readFile(path)).toString("base64"), media_type: type });
      continue;
    }
    const remote = `.nap-attachments/${id}/${basename(path)}`;
    await client.put(remote, await readFile(path));
    named.push(`/workspace/${remote}`);
  }
  const message = [
    request.instructions,
    preamble,
    request.prompt,
    named.length === 0
      ? undefined
      : ["Attached — read each before answering:", ...named].join("\n"),
  ]
    .filter((part) => part !== undefined && part !== "")
    .join("\n\n");
  return { message, images };
}

type Session = { chat_status?: string; pending_agent_calls?: number };
type Message = { role?: string; blocks?: { type?: string; text?: string }[] };

/**
 * Done is no turn running, no handed-off work outstanding, and the last
 * message the agent's: a session read right after the POST can still show
 * the state from before the turn began.
 */
async function awaitAnswer(
  client: NapClient,
  session: string,
  options: NapOptions,
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(options.pollMs ?? 5000);
    if (Date.now() > deadline) {
      await client.json("POST", `/sessions/${session}/interrupt`, {}).catch(() => undefined);
      throw new HarnessError(`NAP did not answer within ${timeoutMs}ms (session ${session})`);
    }
    let state: Session;
    try {
      state = (await client.json("GET", `/sessions/${session}`)) as Session;
    } catch (error) {
      if (isTransient(error)) continue;
      throw error;
    }
    if (state.chat_status === "agent" || (state.pending_agent_calls ?? 0) > 0) {
      continue;
    }
    const messages = (await client.json(
      "GET",
      `/messages?session_id=${encodeURIComponent(session)}`,
    )) as Message[];
    if (messages.at(-1)?.role !== "assistant") {
      continue;
    }
    return answerOf(messages, session);
  }
}

/**
 * The last thing the agent said. A turn's message holds everything it wrote
 * along the way, progress notes included; only the final text is the answer.
 * A message that ends on a tool call was cut off — interrupted, or the agent
 * died — and what it said before that was a note, not an answer.
 */
export function answerOf(messages: Message[], session = "?"): string {
  const last = messages.at(-1);
  const block = last?.blocks?.at(-1);
  const text = block?.type === "text" ? block.text : undefined;
  if (last?.role !== "assistant" || text === undefined || text.trim() === "") {
    throw new HarnessError(`NAP returned no answer (session ${session})`);
  }
  return text;
}

type Usage = {
  totals?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  settlement?: { complete?: boolean };
};

/**
 * Usage is settled a little after the turn; it is waited for briefly, and
 * what is known by then is reported rather than holding up the loop.
 */
async function usageOf(
  client: NapClient,
  session: string,
  pollMs = 5000,
): Promise<TokenUsage | undefined> {
  let usage: Usage | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    usage = (await client.json("GET", `/sessions/${session}/usage`).catch(() => usage)) as
      | Usage
      | undefined;
    if (usage?.settlement?.complete !== false) break;
    await sleep(pollMs);
  }
  return usage === undefined ? undefined : tokensOf(usage);
}

export function tokensOf(usage: Usage): TokenUsage | undefined {
  const totals = usage.totals;
  if (totals === undefined) {
    return undefined;
  }
  return {
    input: totals.input_tokens,
    output: totals.output_tokens,
    ...(totals.cache_read_tokens === undefined ? {} : { cacheRead: totals.cache_read_tokens }),
    ...(totals.cache_creation_tokens === undefined
      ? {}
      : { cacheWrite: totals.cache_creation_tokens }),
  };
}

/** The workspace's REST surface, the little of it the agent uses. */
export type NapClient = {
  workspace: string;
  json(method: string, path: string, body?: unknown): Promise<unknown>;
  /** A file in the workspace, by its path below /workspace. */
  put(path: string, content: Buffer): Promise<void>;
  get(path: string): Promise<Buffer>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<{ name: string; path_type: string; mtime: number; size: number }[]>;
};

export function napClient(options: NapOptions): NapClient {
  const base = options.baseUrl ?? process.env["NAP_BASE_URL"];
  const token = options.token ?? process.env["NAP_TOKEN"];
  if (base === undefined || token === undefined) {
    throw new HarnessError("NAP_BASE_URL and NAP_TOKEN have to be set");
  }
  const doFetch = options.fetch ?? fetch;
  const root = `${base.replace(/\/$/, "")}/api/workspaces/${options.workspace}`;

  async function call(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: BodyInit } = {},
  ): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let response: Response | undefined;
      let failure: unknown;
      try {
        response = await doFetch(`${root}${path}`, {
          ...init,
          method,
          headers: { Authorization: `Bearer ${token}`, ...init.headers },
        });
      } catch (error) {
        failure = error;
      }
      if (response?.ok === true) {
        return response;
      }
      const error =
        response === undefined
          ? new HarnessError(`NAP ${method} ${path} failed: ${String(failure)}`, {
              cause: failure,
            })
          : new HarnessError(
              `NAP ${method} ${path} returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
            );
      const wait = RETRY_WAITS_MS[attempt - 1];
      if (wait === undefined || !isTransient(error)) {
        throw error;
      }
      await sleep(wait);
    }
  }

  const file = (path: string) => `/agent/files?path=${encodeURIComponent(path)}`;
  return {
    workspace: options.workspace,
    async json(method, path, body) {
      const response = await call(
        method,
        path,
        body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      );
      const text = await response.text();
      return text === "" ? undefined : JSON.parse(text);
    },
    async put(path, content) {
      await call("PUT", file(path), {
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(content),
      });
    },
    async get(path) {
      return Buffer.from(await (await call("GET", file(path))).arrayBuffer());
    },
    async remove(path) {
      await call("DELETE", file(path));
    },
    async list(path) {
      const response = await call("GET", `/agent/dirs?path=${encodeURIComponent(path)}`);
      return ((await response.json()) as { entries: [] }).entries;
    },
  };
}

/**
 * How long to wait before each retry of a request that did not get through.
 * A dropped connection or a workspace restarting says nothing about the work,
 * and should not end a run that took an hour to get here.
 */
const RETRY_WAITS_MS = [5_000, 30_000, 120_000];

/** Whether a failure was the platform's rather than the request's: worth trying again. */
export function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return / failed: | returned (429|502|503|504)\b/.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
