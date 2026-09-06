import type { ResearchOptions, Research, Checkpoint, CheckpointStatus, Score } from "./types.js";
import { CheckpointManager } from "./checkpoint.js";

export class ResearchRunner<TMetrics> {
  private options: ResearchOptions<TMetrics>;
  private checkpointManager: CheckpointManager;
  private _research: Research<TMetrics>;

  private constructor(options: ResearchOptions<TMetrics>, research: Research<TMetrics>) {
    this.options = options;
    this.checkpointManager = new CheckpointManager(options.checkpointOptions);
    this._research = research;
  }

  public static async create<TMetrics>(
    options: ResearchOptions<TMetrics>,
  ): Promise<ResearchRunner<TMetrics>> {
    const research = await options.storageProvider.createResearch(options.name);
    return new ResearchRunner(options, research as Research<TMetrics>);
  }

  public static async resume<TMetrics>(
    options: ResearchOptions<TMetrics>,
    researchId: string,
  ): Promise<ResearchRunner<TMetrics>> {
    const research = await options.storageProvider.getResearch(researchId);
    if (research === undefined) {
      throw new Error(`Research not found: ${researchId}`);
    }
    return new ResearchRunner(options, research as Research<TMetrics>);
  }

  public get research(): Research<TMetrics> {
    return this._research;
  }

  /**
   * Best kept score under the same score function. Scores from other
   * versions are on a different scale, so they are not comparable.
   */
  private findBestScore(version: string): number {
    return this._research.checkpoints.reduce<number>((best, current) => {
      if (current.status !== "keep" || current.score?.version !== version) {
        return best;
      }
      return Math.max(best, current.score.value);
    }, 0);
  }

  public async run(): Promise<void> {
    let metrics: TMetrics = {} as TMetrics;
    let status: CheckpointStatus = "keep";
    let score: Score | null = null;
    let errorMsg: string | undefined = undefined;

    try {
      await this.checkpointManager.verifyScope();
      metrics = await this.options.doResearch();
      score = await this.options.doScore(metrics);
      if (score.value <= this.findBestScore(score.version)) {
        status = "discard";
      }
    } catch (error) {
      errorMsg = toError(error).message;
      status = "crash";
    }

    const checkpointId = this.options.storageProvider.newCheckpointId();
    const payload = await this.checkpointManager.createPayload({
      id: checkpointId,
      status,
      score,
      error: errorMsg,
    });

    const checkpoint = await this.options.storageProvider.appendCheckpoint(
      this._research.id,
      checkpointId,
      {
        ...payload,
        status,
        score,
        metrics,
        error: errorMsg,
      },
    );
    this._research.checkpoints.push(checkpoint as Checkpoint<TMetrics>);
    this._research.updatedAt = checkpoint.updatedAt;

    if (status !== "keep") {
      await this.checkpointManager.revert(payload);
    }
  }
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
