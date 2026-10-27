import { expect, test } from "vite-plus/test";
import { researchView, segmentsOf } from "../src/report/model.ts";
import { CheckpointKind, type AnyResearch, type CheckpointStatus } from "../src/types.ts";

function research(checkpoints: [CheckpointStatus, number | null, string | null][]): AnyResearch {
  return {
    id: "r",
    name: "demo",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    checkpoints: checkpoints.map(([status, value, version], index) => ({
      id: `c${index}`,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      kind: CheckpointKind.Dummy,
      status,
      metrics: {
        attempt: { summary: `round ${index}`, usage: { input: 1, output: 2 } },
        timings: { agentMs: 5, note: "x" },
      },
      score: value === null || version === null ? null : { value, version },
      ...(status === "crash" ? { error: "boom" } : {}),
    })),
  };
}

test("counts, and the best score only among kept checkpoints of the latest version", () => {
  const view = researchView(
    research([
      ["keep", 90, "1.0.0"],
      ["keep", 10, "2.0.0"],
      ["discard", 50, "2.0.0"],
      ["crash", null, null],
      ["keep", 20, "2.0.0"],
    ]),
  );
  expect(view.counts).toEqual({ keep: 3, discard: 1, crash: 1 });
  // 90 is higher but scored by another version; 50 was discarded.
  expect(view.best).toEqual({ value: 20, version: "2.0.0", index: 4 });
  expect(view.points[3]).toMatchObject({ status: "crash", score: null, error: "boom" });
  expect(view.points[0]).toMatchObject({ summary: "round 0", usage: { input: 1, output: 2 } });
  // Only numbers are timings.
  expect(view.points[0]!.timings).toEqual({ agentMs: 5 });
});

test("a new score version starts a new segment; a crash stays in the one it falls in", () => {
  const view = researchView(
    research([
      ["keep", 1, "1.0.0"],
      ["crash", null, null],
      ["keep", 2, "1.0.0"],
      ["keep", 3, "2.0.0"],
      ["crash", null, null],
    ]),
  );
  expect(segmentsOf(view.points)).toEqual([
    { version: "1.0.0", from: 0, to: 2 },
    { version: "2.0.0", from: 3, to: 4 },
  ]);
});

test("an empty research has no best and no segments", () => {
  const view = researchView(research([]));
  expect(view.best).toBeUndefined();
  expect(view.segments).toEqual([]);
  expect(view.counts).toEqual({ keep: 0, discard: 0, crash: 0 });
});
