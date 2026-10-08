import { stat,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";

import {
  basename,
  extname,
  join
} from "node:path";

import {
  randomUUID
} from "node:crypto";

import { FfmpegAdapter, MediaValidator } from "@dnyf/media-ffmpeg";

import {
  assertAudioFormat,
  createLogger,
  type ExtractOptions,
  type MediaJob
} from "@dnyf/media-shared";

export interface MediaEngineConfig {
  dataDir: string;
  ffmpeg?: string;
  ffprobe?: string;
  maxConcurrentJobs?: number;
  maxQueuedJobs?: number;
}

function safeName(name: string): string {
  return basename(name)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 180);
}

export class MediaEngine {
  private readonly logger = createLogger(
    "dnyf-media-engine",
    (process.env.DNYF_LOG_LEVEL ?? "info") as
      "debug" | "info" | "warn" | "error"
  );

  private readonly ffmpeg: FfmpegAdapter;
  private readonly validator: MediaValidator;

  private readonly jobs =
    new Map<string, MediaJob>();

  private readonly controllers =
    new Map<string, AbortController>();

  private readonly jobsDir: string;

  private readonly maxConcurrentJobs: number;

  private readonly maxQueuedJobs: number;

  private activeJobs = 0;

  private readonly pendingPersistence =
    new Set<Promise<void>>();

  private readonly pendingTasks =
    new Set<Promise<void>>();

  private readonly waiters: Array<{
    resolve: (acquired: boolean) => void;
    jobId: string;
  }> = [];

  constructor(
    private readonly config: MediaEngineConfig
  ) {
    this.ffmpeg = new FfmpegAdapter(config);
    this.validator = new MediaValidator(config);

    this.jobsDir =
      join(config.dataDir, "jobs");

    this.maxConcurrentJobs =
      Math.max(
        1,
        Math.floor(
          config.maxConcurrentJobs ?? 1
        )
      );

    this.maxQueuedJobs =
      Math.max(
        0,
        Math.floor(
          config.maxQueuedJobs ?? 4
        )
      );
  }

  async init(): Promise<void> {
    await mkdir(
      join(this.config.dataDir, "uploads"),
      { recursive: true }
    );

    await mkdir(
      join(this.config.dataDir, "outputs"),
      { recursive: true }
    );

    await mkdir(
      this.jobsDir,
      { recursive: true }
    );

    await this.loadJobs();

    this.logger.info(
      "engine.initialized",
      {
        dataDir: this.config.dataDir,
        maxConcurrentJobs: this.maxConcurrentJobs,
        maxQueuedJobs: this.maxQueuedJobs
      },
      "media engine initialized"
    );
  }

  getJob(id: string): MediaJob | undefined {
    return this.jobs.get(id);
  }

  async shutdown(): Promise<void> {
    const activeIds = [
      ...this.controllers.keys()
    ];

    for (const id of activeIds) {
      this.cancel(id);
    }

    await Promise.all(
      [...this.jobs.values()]
        .filter(job =>
          [
            "queued",
            "probing",
            "converting"
          ].includes(job.status)
        )
        .map(async job => {
          job.status = "cancelled";
          this.touch(job);

          await this.persistJob(job);
        })
    );

    while (
      this.pendingTasks.size > 0
    ) {
      await Promise.allSettled(
        [...this.pendingTasks]
      );
    }

    while (
      this.pendingPersistence.size > 0
    ) {
      await Promise.allSettled(
        [...this.pendingPersistence]
      );
    }
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);

    if (!job) {
      this.logger.warn(
        "job.cancel.not_found",
        {
          jobId: id
        },
        "job cancellation requested for unknown job"
      );

      return;
    }

    if (
      [
        "completed",
        "failed",
        "cancelled"
      ].includes(job.status)
    ) {
      this.logger.debug(
        "job.cancel.ignored",
        {
          jobId: id,
          status: job.status
        },
        "job cancellation ignored for terminal job"
      );

      return;
    }

    this.logger.info(
      "job.cancel.requested",
      {
        jobId: id,
        status: job.status
      },
      "job cancellation requested"
    );

    this.controllers.get(id)?.abort();

    job.status = "cancelled";
    job.error = "Conversion cancelled";
    this.touch(job);
    void this.persistJob(job);
  }

  async extract(
    inputPath: string,
    originalName: string,
    options: ExtractOptions
  ): Promise<MediaJob> {
    assertAudioFormat(options.format);

    const activeOrQueued =
      [...this.jobs.values()]
        .filter(job =>
          [
            "queued",
            "probing",
            "converting"
          ].includes(job.status)
        ).length;

    const capacity =
      this.maxConcurrentJobs +
      this.maxQueuedJobs;

    if (activeOrQueued >= capacity) {
      throw new Error(
        `Job queue is full. Maximum active/queued jobs: ${capacity}.`
      );
    }

    const id =
      `job_${randomUUID()}`;

    const inputName =
      safeName(originalName);

    const stem =
      safeName(
        basename(
          inputName,
          extname(inputName)
        )
      ) || "audio";

    const outputName =
      `${stem}-${id}.${options.format}`;

    const outputPath =
      join(
        this.config.dataDir,
        "outputs",
        outputName
      );

    const now =
      new Date().toISOString();

    const job: MediaJob = {
      id,
      status: "queued",
      progress: 0,
      inputName,
      outputName,
      outputPath,
      createdAt: now,
      updatedAt: now
    };

    this.jobs.set(id, job);

    await this.persistJob(job);

    this.logger.info(
      "job.created",
      {
        jobId: id,
        inputName,
        outputName,
        format: options.format,
        bitrate: options.bitrate ?? null,
        start: options.start ?? null,
        duration: options.duration ?? null
      },
      "media extraction job created"
    );

    const controller =
      new AbortController();

    this.controllers.set(
      id,
      controller
    );

    const task =
      Promise.resolve().then(async () => {
        let slotAcquired = false;

        try {
          slotAcquired =
            await this.acquireSlot(id);

          if (
            !slotAcquired ||
            job.status === "cancelled"
          ) {
            this.logger.info(
              "job.cancelled",
              {
                jobId: id,
                reason: job.status === "cancelled"
                  ? "cancelled"
                  : "slot-not-acquired"
              },
              "queued job did not start"
            );

            return;
          }

          job.status = "probing";

          this.logger.info(
            "job.probing",
            {
              jobId: id,
              inputName
            },
            "media validation and probing started"
          );
          this.touch(job);
          await this.persistJob(job);

          await this.ffmpeg.probe(
            inputPath
          );

          job.status = "converting";
          this.touch(job);
          await this.persistJob(job);

          this.logger.info(
            "job.converting",
            {
              jobId: id,
              inputName,
              outputName,
              format: options.format
            },
            "media conversion started"
          );

          const conversionStartedAt = Date.now();

          await this.ffmpeg.convert({
            inputPath,
            outputPath,
            format: options.format,
            bitrate: options.bitrate,
            start: options.start,
            duration: options.duration,
            signal: controller.signal,

            onProgress: progress => {
              job.progress =
                Math.max(
                  job.progress,
                  progress
                );

              this.touch(job);

              /*
               * Do not write to disk for every
               * FFmpeg progress event.
               *
               * Persist only meaningful progress
               * changes to reduce storage writes.
               */
              if (
                progress >= 100 ||
                progress % 10 < 1
              ) {
                void this.persistJob(job);
              }
            }
          });

          job.progress = 100;
          job.status = "completed";
          this.touch(job);

          await this.persistJob(job);

          const outputSizeBytes =
            await stat(outputPath)
              .then(result => result.size)
              .catch(() => undefined);

          this.logger.info(
            "job.completed",
            {
              jobId: id,
              outputName,
              format: options.format,
              progress: job.progress,
              durationMs: Date.now() - conversionStartedAt,
              outputSizeBytes: outputSizeBytes ?? null
            },
            "media conversion completed"
          );
        } catch (error) {
          if (controller.signal.aborted) {
            job.status = "cancelled";
            job.error = "Conversion cancelled";

            this.logger.info(
              "job.cancelled",
              {
                jobId: id,
                inputName,
                outputName
              },
              "media conversion cancelled"
            );
          } else {
            job.status = "failed";

            job.error =
              error instanceof Error
                ? error.message
                : String(error);

            this.logger.error(
              "job.failed",
              {
                jobId: id,
                inputName,
                outputName,
                error: job.error
              },
              "media conversion failed"
            );
          }

          this.touch(job);

          await this.persistJob(job);
        } finally {
          this.controllers.delete(id);

          if (slotAcquired) {
            if (this.activeJobs > 0) {
              this.activeJobs--;
            }

            this.releaseNextSlot();
          }

          await unlink(inputPath)
            .catch(() => undefined);
        }
      });

    this.pendingTasks.add(task);

    task.then(
      () => {
        this.pendingTasks.delete(task);
      },
      () => {
        this.pendingTasks.delete(task);
      }
    );

    return job;
  }

  private async acquireSlot(
    jobId: string
  ): Promise<boolean> {
    const job =
      this.jobs.get(jobId);

    if (
      !job ||
      job.status === "cancelled"
    ) {
      return false;
    }

    if (
      this.activeJobs <
      this.maxConcurrentJobs
    ) {
      this.activeJobs++;
      return true;
    }

    const acquired =
      await new Promise<boolean>(
        resolve => {
          this.waiters.push({
            resolve,
            jobId
          });
        }
      );

    if (!acquired) {
      return false;
    }

    const currentJob =
      this.jobs.get(jobId);

    if (
      !currentJob ||
      currentJob.status === "cancelled"
    ) {
      return false;
    }

    this.activeJobs++;
    return true;
  }

  private releaseNextSlot(): void {
    while (this.waiters.length > 0) {
      const waiter =
        this.waiters.shift();

      if (!waiter) {
        return;
      }

      const job =
        this.jobs.get(
          waiter.jobId
        );

      if (
        !job ||
        job.status === "cancelled" ||
        [
          "completed",
          "failed"
        ].includes(job.status)
      ) {
        waiter.resolve(false);
        continue;
      }

      waiter.resolve(true);
      return;
    }
  }


  private async loadJobs(): Promise<void> {
    const entries =
      await readdir(
        this.jobsDir,
        { withFileTypes: true }
      );

    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".json")
      ) {
        continue;
      }

      const path =
        join(
          this.jobsDir,
          entry.name
        );

      try {
        const raw =
          await readFile(
            path,
            "utf8"
          );

        const job =
          JSON.parse(raw) as MediaJob;

        if (
          !job ||
          typeof job.id !== "string" ||
          typeof job.status !== "string"
        ) {
          continue;
        }

        if (
          [
            "queued",
            "probing",
            "converting"
          ].includes(job.status)
        ) {
          job.status = "failed";
          job.error =
            "Job interrupted by engine restart.";
          job.updatedAt =
            new Date().toISOString();
        }

        this.jobs.set(
          job.id,
          job
        );
      } catch {
        /*
         * Leave invalid job metadata untouched.
         * Cleanup can handle it separately.
         */
      }
    }
  }

  private touch(
    job: MediaJob
  ): void {
    job.updatedAt =
      new Date().toISOString();
  }

  private persistJob(
    job: MediaJob
  ): Promise<void> {
    const operation =
      (async () => {
        const path =
          join(
            this.jobsDir,
            `${job.id}.json`
          );

        const tempPath =
          `${path}.${process.pid}.${Date.now()}.${Math.random()
            .toString(16)
            .slice(2)}.tmp`;

        const payload =
          JSON.stringify(
            job,
            null,
            2
          );

        try {
          await writeFile(
            tempPath,
            payload,
            "utf8"
          );

          await rename(
            tempPath,
            path
          );
        } finally {
          await unlink(
            tempPath
          ).catch(
            () => undefined
          );
        }
      })();

    this.pendingPersistence.add(
      operation
    );

    operation.then(
      () => {
        this.pendingPersistence.delete(
          operation
        );
      },
      () => {
        this.pendingPersistence.delete(
          operation
        );
      }
    );

    return operation;
  }

}
