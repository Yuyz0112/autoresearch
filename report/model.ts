import type { AnyCheckpoint, AnyResearch, CheckpointStatus } from "../types.ts";

/**
 * What a report shows of one research, shaped from its ledger and nothing
 * else. Pure, so what the page says can be checked without a page.
 */
export type ResearchView = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  counts: Record<CheckpointStatus, number>;
  /** The best score under the latest score version: earlier ones do not compare. */
  best: { value: number; version: string; index: number } | undefined;
  /** Score versions in the order they appear, each with the checkpoints it scored. */
  segments: Segment[];
  points: Point[];
};

export type Segment = { version: string; from: number; to: number };

export type Point = {
  index: number;
  id: string;
  status: CheckpointStatus;
  /** null for a crash, which never got a score. */
  score: number | null;
  version: string | null;
  createdAt: string;
  commit: string | undefined;
  summary: string | undefined;
  error: string | undefined;
  usage: Usage | undefined;
  /** Durations the metrics recorded, in milliseconds, by name. */
  timings: Record<string, number>;
};

export type Usage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

export function researchView(research: AnyResearch): ResearchView {
  const checkpoints = research.checkpoints ?? [];
  const points = checkpoints.map(pointOf);
  const counts: Record<CheckpointStatus, number> = { keep: 0, discard: 0, crash: 0 };
  for (const point of points) {
    counts[point.status] += 1;
  }
  const segments = segmentsOf(points);
  const latest = segments.at(-1)?.version;
  let best: ResearchView["best"];
  for (const point of points) {
    if (point.score === null || point.version !== latest || point.status !== "keep") {
      continue;
    }
    if (best === undefined || point.score > best.value) {
      best = { value: point.score, version: point.version, index: point.index };
    }
  }
  return {
    id: research.id,
    name: research.name,
    createdAt: research.createdAt,
    updatedAt: research.updatedAt,
    counts,
    best,
    segments,
    points,
  };
}

/**
 * Runs of consecutive checkpoints scored by the same version. A crash has no
 * version and belongs to the run it falls in.
 */
export function segmentsOf(points: Point[]): Segment[] {
  const segments: Segment[] = [];
  for (const point of points) {
    const last = segments.at(-1);
    if (point.version === null || (last !== undefined && last.version === point.version)) {
      if (last !== undefined) {
        last.to = point.index;
      }
      continue;
    }
    segments.push({ version: point.version, from: point.index, to: point.index });
  }
  return segments;
}

function pointOf(checkpoint: AnyCheckpoint, index: number): Point {
  const metrics = (checkpoint.metrics ?? {}) as Record<string, unknown>;
  const attempt = metrics["attempt"] as { summary?: unknown; usage?: Usage } | undefined;
  return {
    index,
    id: checkpoint.id,
    status: checkpoint.status,
    score: checkpoint.score?.value ?? null,
    version: checkpoint.score?.version ?? null,
    createdAt: checkpoint.createdAt,
    commit: "commitHash" in checkpoint ? checkpoint.commitHash : undefined,
    summary: typeof attempt?.summary === "string" ? attempt.summary : undefined,
    error: checkpoint.error,
    usage: attempt?.usage,
    timings: timingsOf(metrics["timings"]),
  };
}

function timingsOf(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}
