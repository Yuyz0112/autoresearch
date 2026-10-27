import { expect, test } from "vite-plus/test";
import { roundsAsked, runRounds } from "../src/rounds.ts";
import { HarnessError } from "../src/runner.ts";
import {
  CheckpointKind,
  type Checkpoint,
  type CheckpointStatus,
  type Research,
} from "../src/types.ts";

type Metrics = { cases: number };

/** A runner whose rounds end as `outcomes` say, one each. */
function runnerOf(outcomes: (CheckpointStatus | Error)[]) {
  const research: Research<Metrics> = {
    id: "r",
    name: "r",
    createdAt: "",
    updatedAt: "",
    checkpoints: [],
  };
  let round = 0;
  return {
    research,
    async run() {
      const outcome = outcomes[round++]!;
      if (outcome instanceof Error) throw outcome;
      research.checkpoints.push({
        id: String(round),
        createdAt: "",
        updatedAt: "",
        kind: CheckpointKind.Dummy,
        status: outcome,
        score: outcome === "crash" ? null : { version: "1", value: round },
        metrics: { cases: round },
        ...(outcome === "crash" ? { error: "renderer threw\nat line 1" } : {}),
      } satisfies Checkpoint<Metrics>);
    },
  };
}

test("rounds stop once the score has not risen for long enough", async () => {
  const lines: string[] = [];
  // A crash is a round without an improvement too.
  const runner = runnerOf([
    "keep",
    "discard",
    "crash",
    "keep",
    "discard",
    "crash",
    "discard",
    "keep",
  ]);
  await runRounds({
    runner,
    rounds: 10,
    stopAfterDiscards: 3,
    details: (metrics) => `${metrics.cases} cases`,
    log: (line) => lines.push(line),
  });
  expect(runner.research.checkpoints).toHaveLength(7);
  expect(lines[0]).toMatch(/round 1: keep {4}score=1 {7} 1 cases$/);
  // A crash says why, on one line.
  expect(lines[2]).toMatch(/round 3: crash {3}score=- {7} renderer threw$/);
  expect(lines.at(-1)).toBe("\nStopped: 3 rounds without an improvement.");
});

test("rounds stop when the harness fails, and say why", async () => {
  const lines: string[] = [];
  const runner = runnerOf(["keep", new HarnessError("Grafana unreachable\nstack"), "keep"]);
  await runRounds({
    runner,
    rounds: 3,
    stopAfterDiscards: 3,
    details: () => "",
    log: (line) => lines.push(line),
  });
  expect(runner.research.checkpoints).toHaveLength(1);
  expect(lines.at(-1)).toMatch(/round 2: stopped — Grafana unreachable$/);
});

test("rounds asked for on the command line", () => {
  expect(roundsAsked(["node", "main.ts"])).toBeUndefined();
  expect(roundsAsked(["node", "main.ts", "--once"])).toBe(1);
  expect(roundsAsked(["node", "main.ts", "--rounds", "3"])).toBe(3);
  expect(roundsAsked(["node", "main.ts", "--rounds", "none"])).toBeUndefined();
});
