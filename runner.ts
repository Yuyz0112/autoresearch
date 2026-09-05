import type {
  ResearchOptions,
  Research,
  Checkpoint,
  ResearchFn,
  CheckpointStatus,
  ScoreFn,
} from "./types.js";
import { CheckpointManager } from "./checkpoint.js";

export class ResearchRunner<TMetrics> {
  private research: Research<TMetrics>;
  private checkpointManager: CheckpointManager<TMetrics>;
  private doResearch: ResearchFn<TMetrics>;
  private doScore: ScoreFn<TMetrics>;

  constructor(options: ResearchOptions<TMetrics>) {
    this.research = this.createResearch(options.name);
    this.checkpointManager = new CheckpointManager(options.checkpointOptions);
    this.doResearch = options.doResearch;
    this.doScore = options.doScore;
  }

  private createResearch(name: string): Research<TMetrics> {
    return {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      checkpoints: [],
    };
  }

  private addCheckpoint(checkpoint: Checkpoint<TMetrics>): void {
    this.research.checkpoints.push(checkpoint);
    this.research.updatedAt = new Date().toISOString();
  }

  private findBestScore(): number {
    if (this.research.checkpoints.length === 0) {
      return 0;
    }

    return this.research.checkpoints.reduce<number>((best, current) => {
      if (current.status !== "keep") {
        return best;
      }

      return Math.max(best, current.score);
    }, 0);
  }

  public async run(): Promise<void> {
    let metrics: TMetrics = {} as TMetrics;
    let status: CheckpointStatus = "keep";
    let score = 0;
    let errorMsg: string | undefined = undefined;

    try {
      metrics = await this.doResearch();
      score = await this.doScore(metrics);
      const best = this.findBestScore();
      if (score <= best) {
        status = "discard";
      }
    } catch (error) {
      errorMsg = toError(error).message;
      status = "crash";
    }

    const checkpoint = await this.checkpointManager.createCheckpoint(
      metrics,
      score,
      status,
      errorMsg,
    );

    this.addCheckpoint(checkpoint);

    if (status !== "keep") {
      await this.checkpointManager.revert(checkpoint);
    }
  }
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
