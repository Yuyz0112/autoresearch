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
  score: number;
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

export type ScoreFn<TMetrics> = (metrics: TMetrics) => Promise<number>;

export type AnyResearch = Research<unknown>;
export type AnyCheckpoint = Checkpoint<unknown>;

export type StorageProvider = {
  createResearch(name: string): Promise<AnyResearch>;
  getResearch(id: string): Promise<AnyResearch | undefined>;
  listResearches(): Promise<string[]>;
  appendCheckpoint(researchId: string, data: CheckpointData<unknown>): Promise<AnyCheckpoint>;
};
