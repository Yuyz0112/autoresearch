import type {
  Checkpoint,
  CheckpointPayload,
  CheckpointStatus,
  CheckpointOptions,
} from "./types.js";
import { CheckpointKind } from "./types.js";
import { simpleGit } from "simple-git";

type CheckpointSummary = {
  id: string;
  status: CheckpointStatus;
  score: number;
  error: string | undefined;
};

export class CheckpointManager<TMetrics> {
  private checkpointOptions: CheckpointOptions;

  constructor(checkpointOptions: CheckpointOptions) {
    this.checkpointOptions = checkpointOptions;
  }

  private async createGitCommitCheckpointPayload(
    repo: string,
    summary: CheckpointSummary,
  ): Promise<CheckpointPayload> {
    const git = simpleGit(repo);
    await git.add("-A");
    // --allow-empty: every checkpoint gets its own commit, even if the
    // subject did not change (append-only log semantics).
    await git.commit(formatCommitMessage(summary), undefined, {
      "--allow-empty": null,
    });
    const commitHash = await git.revparse(["HEAD"]);
    return {
      kind: CheckpointKind.Git,
      repo,
      commitHash,
    };
  }

  public async revert(checkpoint: Checkpoint<TMetrics>): Promise<void> {
    if (checkpoint.kind !== CheckpointKind.Git) {
      return;
    }
    const git = simpleGit(checkpoint.repo);
    await git.raw(["revert", "--no-commit", checkpoint.commitHash]);
    await git.commit(formatRevertMessage(checkpoint.id), undefined, {
      "--allow-empty": null,
    });
  }

  private createDummyCheckpointPayload(): CheckpointPayload {
    return {
      kind: CheckpointKind.Dummy,
    };
  }

  public async createCheckpoint(
    metrics: TMetrics,
    score: number,
    status: CheckpointStatus,
    error: string | undefined,
  ): Promise<Checkpoint<TMetrics>> {
    const id = crypto.randomUUID();
    const payload =
      this.checkpointOptions.kind === CheckpointKind.Git
        ? await this.createGitCommitCheckpointPayload(this.checkpointOptions.repo, {
            id,
            status,
            score,
            error,
          })
        : this.createDummyCheckpointPayload();

    return {
      ...payload,
      status,
      score,
      metrics,
      error,
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Subject line for humans, git trailers for machines:
 *
 *   ar: keep score=12.34 cp=1a2b3c4d
 *
 *   Checkpoint-Id: 1a2b3c4d-....
 *   Checkpoint-Status: keep
 *   Checkpoint-Score: 12.34
 *   Checkpoint-Error: <first line of error>   (crash only)
 *
 * Read back with: git log --format='%(trailers:key=Checkpoint-Id,valueonly)'
 */
export function formatCommitMessage(summary: CheckpointSummary): string {
  const { id, status, score, error } = summary;
  const subject = `ar: ${status} score=${score} cp=${id.slice(0, 8)}`;
  const trailers = [
    `Checkpoint-Id: ${id}`,
    `Checkpoint-Status: ${status}`,
    `Checkpoint-Score: ${score}`,
  ];
  if (error !== undefined) {
    trailers.push(`Checkpoint-Error: ${firstLine(error)}`);
  }
  return `${subject}\n\n${trailers.join("\n")}\n`;
}

export function formatRevertMessage(id: string): string {
  return `ar: revert cp=${id.slice(0, 8)}\n\nCheckpoint-Reverts: ${id}\n`;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}
