import { expect, test } from "vite-plus/test";
import { inParallel } from "../src/parallel.ts";

test("work runs at most so many at a time, and results keep their order", async () => {
  let running = 0;
  let most = 0;
  const results = await inParallel([30, 10, 20, 0, 5], 2, async (wait) => {
    running++;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, wait));
    running--;
    return wait * 2;
  });
  expect(results).toEqual([60, 20, 40, 0, 10]);
  expect(most).toBe(2);
});
