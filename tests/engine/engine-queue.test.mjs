import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MediaEngine } from "../../packages/engine/dist/index.js";

const INPUT = join(
  process.cwd(),
  "data/test/input.mp4"
);

async function waitForJob(
  engine,
  jobId,
  predicate = job =>
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled",
  timeoutMs = 30_000
) {
  const deadline =
    Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const job = engine.getJob(jobId);

    if (!job) {
      throw new Error(
        `Job ${jobId} disappeared`
      );
    }

    if (predicate(job)) {
      return job;
    }

    await new Promise(resolve =>
      setTimeout(resolve, 50)
    );
  }

  throw new Error(
    `Timed out waiting for job ${jobId}`
  );
}

async function createEngine(config = {}) {
  const root =
    await mkdtemp(
      join(
        tmpdir(),
        "dnyf-media-engine-test-"
      )
    );

  const engine =
    new MediaEngine({
      dataDir: root,
      maxConcurrentJobs:
        config.maxConcurrentJobs ?? 1,
      maxQueuedJobs:
        config.maxQueuedJobs ?? 4
    });

  await engine.init();

  return {
    engine,
    root
  };
}

async function createInput(root, name) {
  const path =
    join(
      root,
      `${name}.mp4`
    );

  const data =
    await readFile(INPUT);

  await writeFile(path, data);

  return path;
}

test(
  "active FFmpeg cancellation releases the worker slot",
  async () => {
    const { engine, root } =
      await createEngine({
        maxConcurrentJobs: 1,
        maxQueuedJobs: 1
      });

    try {
      const source =
        join(
          process.cwd(),
          "data/test/cancellation-input.mp4"
        );

      const firstInput =
        join(
          root,
          "active-cancellation-first.mp4"
        );

      const secondInput =
        join(
          root,
          "active-cancellation-second.mp4"
        );

      const sourceData =
        await readFile(source);

      await writeFile(
        firstInput,
        sourceData
      );

      await writeFile(
        secondInput,
        sourceData
      );

      const first =
        await engine.extract(
          firstInput,
          "active-cancellation-first.mp4",
          { format: "mp3" }
        );

      const second =
        await engine.extract(
          secondInput,
          "active-cancellation-second.mp4",
          { format: "mp3" }
        );

      await waitForJob(
        engine,
        first.id,
        current =>
          current.status === "converting",
        30_000
      );

      const converting =
        engine.getJob(first.id);

      assert.ok(
        converting,
        "Active job should exist"
      );

      assert.equal(
        converting.status,
        "converting"
      );

      const queued =
        engine.getJob(second.id);

      assert.ok(
        queued,
        "Second job should exist"
      );

      assert.equal(
        queued.status,
        "queued"
      );

      engine.cancel(first.id);

      const cancelled =
        await waitForJob(
          engine,
          first.id,
          current =>
            current.status === "cancelled",
          30_000
        );

      assert.equal(
        cancelled.status,
        "cancelled"
      );

      assert.match(
        cancelled.error ?? "",
        /cancelled/i
      );

      const completed =
        await waitForJob(
          engine,
          second.id,
          current =>
            current.status === "completed" ||
            current.status === "failed",
          30_000
        );

      assert.equal(
        completed.status,
        "completed",
        completed.error
      );

      assert.equal(
        completed.progress,
        100
      );
    } finally {
      await engine.shutdown();

      await rm(root, {
        recursive: true,
        force: true
      });
    }
  }
);

test(
  "queued cancellation does not consume a worker slot",
  async () => {
    const { engine, root } =
      await createEngine({
        maxConcurrentJobs: 1,
        maxQueuedJobs: 2
      });

    try {
      const firstInput =
        await createInput(
          root,
          "first"
        );

      const secondInput =
        await createInput(
          root,
          "second"
        );

      const thirdInput =
        await createInput(
          root,
          "third"
        );

      const first =
        await engine.extract(
          firstInput,
          "first.mp4",
          { format: "mp3" }
        );

      const second =
        await engine.extract(
          secondInput,
          "second.mp4",
          { format: "mp3" }
        );

      const third =
        await engine.extract(
          thirdInput,
          "third.mp4",
          { format: "mp3" }
        );

      await waitForJob(
        engine,
        first.id,
        job =>
          [
            "probing",
            "converting",
            "completed"
          ].includes(job.status)
      );

      const queuedSecond =
        engine.getJob(second.id);

      assert.ok(
        queuedSecond,
        "Second job should exist"
      );

      assert.equal(
        queuedSecond.status,
        "queued"
      );

      const queuedThird =
        engine.getJob(third.id);

      assert.ok(
        queuedThird,
        "Third job should exist"
      );

      assert.equal(
        queuedThird.status,
        "queued"
      );

      engine.cancel(second.id);

      const cancelled =
        await waitForJob(
          engine,
          second.id
        );

      assert.equal(
        cancelled.status,
        "cancelled"
      );

      const completedFirst =
        await waitForJob(
          engine,
          first.id
        );

      assert.equal(
        completedFirst.status,
        "completed",
        completedFirst.error
      );

      const completedThird =
        await waitForJob(
          engine,
          third.id
        );

      assert.equal(
        completedThird.status,
        "completed",
        completedThird.error
      );

      assert.equal(
        completedFirst.progress,
        100
      );

      assert.equal(
        completedThird.progress,
        100
      );
    } finally {
      await engine.shutdown();
      await rm(root, {
        recursive: true,
        force: true
      });
    }
  }
);

test(
  "queue capacity rejects jobs beyond active plus queued limit",
  async () => {
    const { engine, root } =
      await createEngine({
        maxConcurrentJobs: 1,
        maxQueuedJobs: 1
      });

    try {
      const firstInput =
        await createInput(
          root,
          "capacity-first"
        );

      const secondInput =
        await createInput(
          root,
          "capacity-second"
        );

      const thirdInput =
        await createInput(
          root,
          "capacity-third"
        );

      const first =
        await engine.extract(
          firstInput,
          "capacity-first.mp4",
          { format: "mp3" }
        );

      const second =
        await engine.extract(
          secondInput,
          "capacity-second.mp4",
          { format: "mp3" }
        );

      await assert.rejects(
        () =>
          engine.extract(
            thirdInput,
            "capacity-third.mp4",
            { format: "mp3" }
          ),
        /Job queue is full/
      );

      engine.cancel(second.id);

      await waitForJob(
        engine,
        second.id
      );

      const completed =
        await waitForJob(
          engine,
          first.id
        );

      assert.equal(
        completed.status,
        "completed",
        completed.error
      );
    } finally {
      await engine.shutdown();
      await rm(root, {
        recursive: true,
        force: true
      });
    }
  }
);

test(
  "cancelled queued job remains persisted as cancelled",
  async () => {
    const { engine, root } =
      await createEngine({
        maxConcurrentJobs: 1,
        maxQueuedJobs: 1
      });

    try {
      const firstInput =
        await createInput(
          root,
          "persist-first"
        );

      const secondInput =
        await createInput(
          root,
          "persist-second"
        );

      const first =
        await engine.extract(
          firstInput,
          "persist-first.mp4",
          { format: "mp3" }
        );

      const second =
        await engine.extract(
          secondInput,
          "persist-second.mp4",
          { format: "mp3" }
        );

      engine.cancel(second.id);

      const cancelled =
        await waitForJob(
          engine,
          second.id
        );

      assert.equal(
        cancelled.status,
        "cancelled"
      );

      const metadataPath =
        join(
          root,
          "jobs",
          `${second.id}.json`
        );

      let metadata;

      const metadataDeadline =
        Date.now() + 5_000;

      while (
        Date.now() <
        metadataDeadline
      ) {
        try {
          metadata =
            JSON.parse(
              await readFile(
                metadataPath,
                "utf8"
              )
            );

          if (
            metadata.status ===
            "cancelled"
          ) {
            break;
          }
        } catch {
          // Persistence may not have created
          // the metadata file yet.
        }

        await new Promise(
          resolve =>
            setTimeout(resolve, 25)
        );
      }

      assert.ok(
        metadata,
        "Job metadata was not persisted"
      );

      assert.equal(
        metadata.id,
        second.id
      );

      assert.equal(
        metadata.status,
        "cancelled"
      );

      engine.cancel(first.id);

      await waitForJob(
        engine,
        first.id
      );
    } finally {
      await engine.shutdown();
      await rm(root, {
        recursive: true,
        force: true
      });
    }
  }
);
