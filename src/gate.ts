import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

/**
 * A check the subject has to pass before anything is measured, like the lint
 * and type checks the rest of a repository passes. It failing is the
 * experiment failing: the round crashes, and is reverted like any other.
 */
export async function gate(binary: string, args: string[], cwd: string): Promise<void> {
  if (!existsSync(binary)) {
    throw new Error(`${binary} is missing; install the repository's packages`);
  }
  const { code, output } = await run(binary, args, cwd);
  if (code !== 0) {
    throw new Error(gateFailure(`${basename(binary)} ${args.join(" ")}`, output));
  }
}

/** The first lines of what the check said, without its colours. */
export function gateFailure(command: string, output: string, limit = 20): string {
  const lines = output
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("note:"));
  const shown = lines.slice(0, limit);
  const more = lines.length > limit ? `\n  … ${lines.length - limit} more lines` : "";
  return `${command} failed:\n  ${shown.join("\n  ")}${more}`;
}

function run(
  binary: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("error", (error) => resolve({ code: 1, output: String(error) }));
    child.once("close", (code) => resolve({ code: code ?? 1, output }));
  });
}
