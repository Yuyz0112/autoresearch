type BasicMetadata = {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type ResearchOptions<TMetrics> = {
  name: string;
  checkpointOptions: CheckpointOptions;
  doResearch: ResearchFn<TMetrics>;
  doScore: ScoreFn<TMetrics>;
};

export type CheckpointOptions =
  | {
      kind: CheckpointKind.Dummy;
    }
  | {
      kind: CheckpointKind.Git;
      repo: string;
    };

export type Research<TMetrics> = {
  name: string;
  checkpoints: Checkpoint<TMetrics>[];
} & BasicMetadata;

export type Checkpoint<TMetrics> = BasicMetadata & {
  status: CheckpointStatus;
  metrics: TMetrics;
  score: number;
  error?: string;
} & CheckpointPayload;

export type CheckpointPayload = GitCommitCheckpoint | DummyCheckpoint;

type GitCommitCheckpoint = {
  kind: CheckpointKind.Git;
  repo: string;
  commitHash: string;
};

// for unit testing purposes
type DummyCheckpoint = {
  kind: CheckpointKind.Dummy;
};

export type CheckpointStatus = "keep" | "discard" | "crash";

export enum CheckpointKind {
  Git = "git",
  Dummy = "dummy",
}

export type ResearchFn<TMetrics> = () => Promise<TMetrics>;

export type ScoreFn<TMetrics> = (metrics: TMetrics) => Promise<number>;
