import { expect, test } from "vite-plus/test";
import { gate, gateFailure } from "../src/gate.ts";

test("a failed gate says what the check said, without colours, cut short", () => {
  const output = [
    "\x1b[1mnote:\x1b[0m running vp check",
    "\x1b[31merror:\x1b[0m Lint or type issues found",
    ...Array.from({ length: 30 }, (_, index) => `line ${index}`),
  ].join("\n");
  expect(gateFailure("vp check", output, 5)).toBe(
    "vp check failed:\n  error: Lint or type issues found\n  line 0\n  line 1\n  line 2\n  line 3\n  … 26 more lines",
  );
});

test("a gate passes on success and fails the round otherwise", async () => {
  await expect(gate("/bin/sh", ["-c", "exit 0"], "/")).resolves.toBeUndefined();
  await expect(gate("/bin/sh", ["-c", "echo broken; exit 1"], "/")).rejects.toThrow(
    "sh -c echo broken; exit 1 failed:\n  broken",
  );
  await expect(gate("/no/such/binary", [], "/")).rejects.toThrow(/missing/);
});
