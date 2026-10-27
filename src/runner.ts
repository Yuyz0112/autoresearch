import type { ResearchOptions, Research, Checkpoint, CheckpointStatus, Score } from "./types.ts";
import { CheckpointKind } from "./types.ts";
import { CheckpointManager } from "./checkpoint.ts";

/**
 * Thrown when the harness itself could not run the experiment — the service it
 * measures against is down, the subject directory is missing, something needs
 * a person. The runner lets it through untouched: no checkpoint is recorded
 * and nothing is reverted, because the subject did nothing wrong and its work
 * should survive.
 */
export class HarnessError extends Error {}

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

  /** Continue the research named in the options, starting it on first run. */
  public static async open<TMetrics>(
    options: ResearchOptions<TMetrics>,
  ): Promise<ResearchRunner<TMetrics>> {
    const research = await options.storageProvider.openResearch(options.name);
    assertSameRepo(research as Research<TMetrics>, options);
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
    assertSameRepo(research as Research<TMetrics>, options);
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
    }, Number.NEGATIVE_INFINITY);
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
      if (error instanceof HarnessError) {
        throw error;
      }
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

/**
 * A research's checkpoints are commits on one branch in one worktree. Pointed
 * at a different one, a revert would restore a tree the scores never described.
 */
function assertSameRepo<TMetrics>(
  research: Research<TMetrics>,
  options: ResearchOptions<TMetrics>,
): void {
  if (options.checkpointOptions.kind !== CheckpointKind.Git) {
    return;
  }
  const { repo } = options.checkpointOptions;
  for (let i = research.checkpoints.length - 1; i >= 0; i--) {
    const checkpoint = research.checkpoints[i]!;
    if (checkpoint.kind !== CheckpointKind.Git) {
      continue;
    }
    if (checkpoint.repo !== repo) {
      throw new Error(
        `Research ${research.name} is checkpointed in ${checkpoint.repo}, not ${repo}`,
      );
    }
    return;
  }
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
