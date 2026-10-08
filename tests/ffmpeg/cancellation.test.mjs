import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FfmpegAdapter } from "../../packages/ffmpeg/dist/index.js";

const INPUT = join(
  process.cwd(),
  "data/test/cancellation-input.mp4"
);

async function waitFor(
  predicate,
  timeoutMs = 10_000,
  intervalMs = 50
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise(resolve =>
      setTimeout(resolve, intervalMs)
    );
  }

  throw new Error("Timed out waiting for condition.");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test(
  "FFmpeg process exits after AbortSignal cancellation",
  async () => {
    const root =
      await mkdtemp(
        join(
          tmpdir(),
          "dnyf-ffmpeg-cancel-"
        )
      );

    const output =
      join(
        root,
        "cancelled.mp3"
      );

    const controller =
      new AbortController();

    const adapter =
      new FfmpegAdapter();

    let pid;

    try {
      const inputData =
        await readFile(INPUT);

      assert.ok(
        inputData.length > 0,
        "Cancellation fixture is empty"
      );

      const conversion =
        adapter.convert({
          inputPath: INPUT,
          outputPath: output,
          format: "mp3",
          signal: controller.signal,
          onProcess: childPid => {
            pid = childPid;
          }
        });

      await waitFor(
        () => pid !== undefined,
        5_000
      );

      assert.ok(
        pid > 0,
        `Invalid FFmpeg PID: ${pid}`
      );

      await waitFor(
        () => processExists(pid),
        5_000
      );

      controller.abort();

      await assert.rejects(
        conversion,
        /conversion cancelled/i
      );

      await waitFor(
        () => !processExists(pid),
        5_000
      );

      assert.equal(
        processExists(pid),
        false,
        `FFmpeg process ${pid} is still running`
      );
    } finally {
      controller.abort();

      await Promise.resolve();

      await rm(
        root,
        {
          recursive: true,
          force: true
        }
      );
    }
  }
);
