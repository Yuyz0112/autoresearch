export type BasicMetadata = {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type ResearchOptions<TMetrics> = {
  name: string;
  checkpointOptions: CheckpointOptions;
  doResearch: ResearchFn<TMetrics>;
  doScore: ScoreFn<TMetrics>;
  storageProvider: StorageProvider;
};

export type CheckpointOptions =
  | {
      kind: CheckpointKind.Dummy;
    }
  | {
      kind: CheckpointKind.Git;
      repo: string;
      // Paths the subject is confined to, relative to the repo root. Changes
      // outside them fail the checkpoint instead of being silently committed.
      scope?: string[];
    };

export type Research<TMetrics> = {
  name: string;
  checkpoints: Checkpoint<TMetrics>[];
} & BasicMetadata;

export type CheckpointData<TMetrics> = {
  status: CheckpointStatus;
  metrics: TMetrics;
  // null when the run crashed before a score existed.
  score: Score | null;
  error?: string;
} & CheckpointPayload;

export type Checkpoint<TMetrics> = BasicMetadata & CheckpointData<TMetrics>;

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

export type Score = {
  // a semantic version string of the score function
  version: string;
  value: number;
};

export type ScoreFn<TMetrics> = (metrics: TMetrics) => Promise<Score>;

export type AnyResearch = Research<unknown>;
export type AnyCheckpoint = Checkpoint<unknown>;

export type StorageProvider = {
  createResearch(name: string): Promise<AnyResearch>;
  // The named research, created on first use. Names are the stable handle;
  // ids stay opaque.
  openResearch(name: string): Promise<AnyResearch>;
  getResearch(id: string): Promise<AnyResearch | undefined>;
  listResearches(): Promise<string[]>;
  // Allocated before the checkpoint exists, so a carrier can reference it.
  newCheckpointId(): string;
  appendCheckpoint(
    researchId: string,
    id: string,
    data: CheckpointData<unknown>,
  ): Promise<AnyCheckpoint>;
};
