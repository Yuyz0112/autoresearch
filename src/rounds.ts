import { HarnessError } from "./runner.ts";
import type { Checkpoint, Research } from "./types.ts";

export type RoundsOptions<TMetrics> = {
  /** A runner, or anything that runs a round and records it the same way. */
  runner: { run(): Promise<void>; research: Research<TMetrics> };
  rounds: number;
  /** A hill that has stopped rising does not start again by being climbed harder. */
  stopAfterDiscards: number;
  /** What a measured round is reported with, after its status and score. */
  details: (metrics: TMetrics) => string;
  /** Before each round: whatever the harness needs in place, like a service kept awake. */
  beforeRound?: () => Promise<void>;
  log?: (line: string) => void;
};

/**
 * Rounds until the count is spent, the score stops rising, or the harness
 * fails. A failed experiment is a checkpoint and the rounds go on; a failed
 * harness stops them, since the next round would fail the same way.
 */
export async function runRounds<TMetrics>(options: RoundsOptions<TMetrics>): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  let discardsInARow = 0;
  for (let round = 1; round <= options.rounds; round++) {
    const at = new Date().toISOString().slice(11, 19);
    try {
      await options.beforeRound?.();
      await options.runner.run();
    } catch (error) {
      // Only the harness reaches here; a bad experiment is a checkpoint.
      log(`${at}  round ${round}: stopped — ${describe(error)}`);
      return;
    }
    const last = options.runner.research.checkpoints.at(-1);
    if (last === undefined) {
      return;
    }
    log(`${at}  round ${round}: ${lineOf(last, options.details)}`);
    discardsInARow = last.status === "keep" ? 0 : discardsInARow + 1;
    if (discardsInARow >= options.stopAfterDiscards) {
      log(`\nStopped: ${options.stopAfterDiscards} rounds without an improvement.`);
      return;
    }
  }
}

function lineOf<TMetrics>(
  checkpoint: Checkpoint<TMetrics>,
  details: (metrics: TMetrics) => string,
): string {
  const head = `${checkpoint.status.padEnd(7)} score=${String(checkpoint.score?.value ?? "-").padEnd(8)}`;
  if (checkpoint.error !== undefined) {
    return `${head} ${checkpoint.error.split("\n")[0]?.slice(0, 90) ?? ""}`;
  }
  return `${head} ${details(checkpoint.metrics)}`;
}

/** `--once`, or `--rounds N`, to spend less than the default unattended. */
export function roundsAsked(argv: string[] = process.argv): number | undefined {
  if (argv.includes("--once")) {
    return 1;
  }
  const at = argv.indexOf("--rounds");
  const count = at === -1 ? Number.NaN : Number(argv[at + 1]);
  return Number.isInteger(count) && count > 0 ? count : undefined;
}

function describe(error: unknown): string {
  if (error instanceof HarnessError) {
    return error.message.split("\n")[0] ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
