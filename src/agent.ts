/**
 * One stateless turn of asking something to produce text. Nothing carries
 * over between calls, so a request has to say everything the turn needs —
 * which is also what keeps the loop reproducible and lets the same interface
 * cover a local CLI, a hosted agent or a plain model call.
 */
export type Agent = {
  /** Recorded alongside what the turn produced, so a result can be traced. */
  name: string;
  ask(request: AgentRequest): Promise<AgentReply>;
};

export type AgentRequest = {
  /** The agent's standing instructions: its role, its rules, its output format. */
  instructions: string;
  /** This turn's task. */
  prompt: string;
  /** Where paths named in the prompt resolve. Ignored by agents that cannot read files. */
  cwd: string;
  /**
   * Files the turn has to look at — a screenshot to judge, say. Paths, so a
   * request never carries a copy: an agent that reads files is pointed at
   * them, and one that takes content inline attaches them itself.
   */
  attachments?: string[];
};

export type AgentReply = {
  text: string;
  /** What the turn consumed, when the agent knows. */
  usage?: TokenUsage;
};

/**
 * Tokens rather than money: prices change and differ per backend, while the
 * counts are the thing the loop can actually be tuned against.
 */
export type TokenUsage = {
  input: number;
  output: number;
  /** Absent where the backend does not cache, or does not say. */
  cacheRead?: number;
  cacheWrite?: number;
};
