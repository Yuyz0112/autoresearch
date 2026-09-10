import type { CheckpointPayload, CheckpointStatus, CheckpointOptions, Score } from "./types.ts";
import { CheckpointKind } from "./types.ts";
import { simpleGit } from "simple-git";

export type CheckpointSummary = {
  id: string;
  status: CheckpointStatus;
  score: Score | null;
  error: string | undefined;
};

export class CheckpointManager {
  private checkpointOptions: CheckpointOptions;

  constructor(checkpointOptions: CheckpointOptions) {
    this.checkpointOptions = checkpointOptions;
  }

  public async createPayload(summary: CheckpointSummary): Promise<CheckpointPayload> {
    if (this.checkpointOptions.kind === CheckpointKind.Git) {
      return this.createGitCommitCheckpointPayload(this.checkpointOptions.repo, summary);
    }
    return { kind: CheckpointKind.Dummy };
  }

  public async verifyScope(): Promise<void> {
    if (this.checkpointOptions.kind !== CheckpointKind.Git) {
      return;
    }
    const { repo, scope } = this.checkpointOptions;
    if (scope === undefined || scope.length === 0) {
      return;
    }
    const git = simpleGit(repo);
    const status = await git.raw(["status", "--porcelain", "-z", "--untracked-files=all"]);
    const offending = changedPaths(status).filter((path) => !isWithinScope(path, scope));
    if (offending.length > 0) {
      throw new Error(
        `Changes outside the subject scope: ${[...new Set(offending)].sort().join(", ")}`,
      );
    }
  }

  public async revert(payload: CheckpointPayload): Promise<void> {
    if (payload.kind !== CheckpointKind.Git) {
      return;
    }
    const git = simpleGit(payload.repo);
    await git.raw(["revert", "--no-commit", payload.commitHash]);
    await git.commit(formatRevertMessage(payload.commitHash), undefined, {
      "--allow-empty": null,
    });
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
}

/**
 * A human-readable subject and a pointer to the ledger:
 *
 *   ar: keep score=12.34
 *
 *   Checkpoint-Id: 1a2b3c4d-....
 *
 * The subject is a label; the ledger holds the checkpoint itself.
 * Read back with: git log --format='%(trailers:key=Checkpoint-Id,valueonly)'
 */
export function formatCommitMessage(summary: CheckpointSummary): string {
  const { id, status, score } = summary;
  const subject = score === null ? `ar: ${status}` : `ar: ${status} score=${score.value}`;
  return `${subject}\n\nCheckpoint-Id: ${id}\n`;
}

export function formatRevertMessage(commitHash: string): string {
  return `ar: revert ${commitHash.slice(0, 8)}\n\nThis reverts commit ${commitHash}.\n`;
}

/** Paths touched in `git status --porcelain -z`, renames counted on both ends. */
function changedPaths(status: string): string[] {
  const entries = status.split("\0").filter((entry) => entry !== "");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    paths.push(entry.slice(3));
    if (entry.startsWith("R") || entry.startsWith("C")) {
      const origin = entries[++i];
      if (origin !== undefined) {
        paths.push(origin);
      }
    }
  }
  return paths;
}

function isWithinScope(path: string, scope: string[]): boolean {
  return scope.some((entry) => {
    const prefix = entry.replace(/\/+$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  });
}
