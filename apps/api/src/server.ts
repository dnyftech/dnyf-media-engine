import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";

import {
  mkdir,
  stat,
  statfs,
  writeFile
} from "node:fs/promises";

import {
  createReadStream
} from "node:fs";

import {
  dirname,
  join
} from "node:path";

import {
  fileURLToPath
} from "node:url";

import {
  randomUUID
} from "node:crypto";

import {
  MediaEngine
} from "@dnyf/media-engine";

import {
  AUDIO_FORMATS,
  MediaError,
  createLogger,
  type AudioFormat
} from "@dnyf/media-shared";

const logger = createLogger(
  "dnyf-media-api",
  (process.env.DNYF_LOG_LEVEL ?? "info") as
    "debug" | "info" | "warn" | "error"
);

const host =
  process.env.DNYF_MEDIA_HOST ??
  "127.0.0.1";

const port =
  Number(
    process.env.DNYF_MEDIA_PORT ??
    8787
  );

const projectRoot =
  join(
    dirname(
      fileURLToPath(import.meta.url)
    ),
    "../../.."
  );

const dataDir =
  process.env.DNYF_MEDIA_DATA_DIR ??
  join(
    projectRoot,
    "data"
  );

const maxBytes =
  Number(
    process.env.DNYF_MEDIA_MAX_FILE_MB ??
    2048
  ) *
  1024 *
  1024;

const minFreeBytes =
  Number(
    process.env.DNYF_MEDIA_MIN_FREE_MB ??
    512
  ) *
  1024 *
  1024;

const allowedOrigins =
  (
    process.env.DNYF_MEDIA_CORS_ORIGINS ??
    "http://127.0.0.1:3000,http://localhost:3000"
  )
    .split(",")
    .map(
      origin =>
        origin.trim()
    )
    .filter(Boolean);

const engine =
  new MediaEngine({
    dataDir,
    maxConcurrentJobs:
      Number(
        process.env.DNYF_MEDIA_MAX_CONCURRENT_JOBS ??
        1
      ),
    maxQueuedJobs:
      Number(
        process.env.DNYF_MEDIA_MAX_QUEUED_JOBS ??
        4
      )
  });

await engine.init();

let ready = true;
let shuttingDown = false;

const shutdownTimeoutMs =
  Number(
    process.env.DNYF_SHUTDOWN_TIMEOUT_MS ??
    15000
  );

const shutdown = async (
  signal: string
): Promise<void> => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  ready = false;

  logger.info(
    "server.shutdown.started",
    { signal },
    `received ${signal}; shutting down`
  );

  const started = Date.now();

  try {
    await Promise.race([
      engine.shutdown(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `shutdown timeout after ${shutdownTimeoutMs}ms`
            )
          );
        }, shutdownTimeoutMs);

        timer.unref();
      })
    ]);

    logger.info(
      "server.shutdown.completed",
      {
        signal,
        durationMs:
          Date.now() - started
      }
    );
  } catch (error) {
    logger.error(
      "server.shutdown.failed",
      {
        signal,
        durationMs:
          Date.now() - started,
        error:
          error instanceof Error
            ? error.message
            : String(error)
      }
    );
  }

  process.exit(0);
};

process.once(
  "SIGINT",
  () => {
    void shutdown("SIGINT");
  }
);

process.once(
  "SIGTERM",
  () => {
    void shutdown("SIGTERM");
  }
);

const app =
  new Hono();

app.use(
  "*",
  async (c, next) => {
    const suppliedRequestId =
      c.req.header("X-Request-ID");

    const requestId =
      suppliedRequestId &&
      /^[A-Za-z0-9._-]{1,128}$/.test(
        suppliedRequestId
      )
        ? suppliedRequestId
        : randomUUID();

    const started = Date.now();

    c.header(
      "X-Request-ID",
      requestId
    );

    const requestLogger =
      logger.child({
        requestId
      });

    try {
      await next();
    } finally {
      requestLogger.info(
        "request.completed",
        {
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          durationMs:
            Date.now() - started
        }
      );
    }
  }
);

function apiError(
  c: Context,
  status: 400 | 404 | 413 | 429 | 500 | 507,
  code: string,
  message: string,
  details?: Record<string, unknown>
) {
  return c.json(
    {
      error: {
        code,
        message,
        status,
        ...(details
          ? { details }
          : {})
      }
    },
    status
  );
}

app.use(
  "*",
  cors({
    origin: origin => {
      if (!origin) {
        return "";
      }

      return allowedOrigins.includes(
        origin
      )
        ? origin
        : "";
    }
  })
);

app.get(
  "/health",
  c =>
    c.json({
      ok: true,
      service: "dnyf-media-api",
      version: "0.1.0"
    })
);

app.get(
  "/ready",
  c => {
    if (!ready || shuttingDown) {
      return c.json(
        {
          ok: false,
          service: "dnyf-media-api",
          ready: false
        },
        503
      );
    }

    return c.json({
      ok: true,
      service: "dnyf-media-api",
      ready: true
    });
  }
);

app.post(
  "/v1/media/extract",
  async c => {
    const body =
      await c.req.parseBody();

    const file =
      body.file;

    if (!(file instanceof File)) {
      return apiError(
        c,
        400,
        "FILE_REQUIRED",
        "file is required"
      );
    }

    if (
      file.size <= 0
    ) {
      return apiError(
        c,
        400,
        "FILE_EMPTY",
        "file is empty"
      );
    }

    if (
      file.size >
      maxBytes
    ) {
      return apiError(
        c,
        413,
        "FILE_TOO_LARGE",
        "file exceeds configured size limit",
        {
          maxBytes
        }
      );
    }

    const formatValue =
      String(
        body.format ??
        "mp3"
      ).toLowerCase();

    if (
      !AUDIO_FORMATS.includes(
        formatValue as AudioFormat
      )
    ) {
      return apiError(
        c,
        400,
        "UNSUPPORTED_FORMAT",
        `unsupported format: ${formatValue}`,
        {
          supportedFormats:
            AUDIO_FORMATS
        }
      );
    }

    const format =
      formatValue as AudioFormat;

    const originalName =
      file.name ||
      "input";

    const extension =
      originalName
        .split(".")
        .pop()
        ?.toLowerCase() ??
      "";

    const allowedInputExtensions =
      new Set([
        "mp4",
        "m4v",
        "mov",
        "mkv",
        "webm",
        "avi",
        "flv",
        "wmv",
        "mpeg",
        "mpg",
        "3gp",
        "ts"
      ]);

    if (
      extension &&
      !allowedInputExtensions.has(
        extension
      )
    ) {
      return apiError(
        c,
        400,
        "UNSUPPORTED_INPUT",
        `unsupported input extension: .${extension}`
      );
    }

    const uploads =
      join(
        dataDir,
        "uploads"
      );

    await mkdir(
      uploads,
      {
        recursive: true
      }
    );

    const filesystem =
      await statfs(dataDir);

    const availableBytes =
      Number(filesystem.bavail) *
      Number(filesystem.bsize);

    if (
      availableBytes <
      file.size + minFreeBytes
    ) {
      return apiError(
        c,
        507,
        "INSUFFICIENT_STORAGE",
        "insufficient free storage",
        {
          availableBytes,
          requiredBytes:
            file.size +
            minFreeBytes
        }
      );
    }

    const id =
      randomUUID();

    const safeOriginal =
      originalName
        .replace(
          /[^a-zA-Z0-9._-]/g,
          "_"
        )
        .slice(0, 180) ||
      "input";

    const inputPath =
      join(
        uploads,
        `${id}-${safeOriginal}`
      );

    try {
      await writeFile(
        inputPath,
        Buffer.from(
          await file.arrayBuffer()
        )
      );

      const job =
        await engine.extract(
          inputPath,
          originalName,
          {
            format,
            bitrate:
              body.bitrate
                ? String(
                    body.bitrate
                  )
                : undefined,
            start:
              body.start
                ? String(
                    body.start
                  )
                : undefined,
            duration:
              body.duration
                ? String(
                    body.duration
                  )
                : undefined
          }
        );

      logger.info(
        "media.extract.accepted",
        {
          jobId: job.id,
          format,
          inputName: originalName
        }
      );

      return c.json(
        {
          jobId: job.id,
          status: job.status
        },
        202
      );
    } catch (error) {
      if (
        error instanceof MediaError
      ) {
        return apiError(
          c,
          error.statusCode as
            400 | 404 | 413 | 429 | 500 | 507,
          error.code,
          error.message
        );
      }

      if (
        error instanceof Error &&
        error.message.startsWith(
          "Job queue is full."
        )
      ) {
        return apiError(
          c,
          429,
          "JOB_QUEUE_FULL",
          error.message
        );
      }

      return apiError(
        c,
        500,
        "CONVERSION_FAILED",
        error instanceof Error
          ? error.message
          : String(error)
      );
    }
  }
);

app.get(
  "/v1/jobs/:id",
  c => {
    const job =
      engine.getJob(
        c.req.param("id")
      );

    if (!job) {
      return apiError(
        c,
        404,
        "JOB_NOT_FOUND",
        "job not found"
      );
    }

    return c.json(job);
  }
);

app.post(
  "/v1/jobs/:id/cancel",
  c => {
    const job =
      engine.getJob(
        c.req.param("id")
      );

    if (!job) {
      return apiError(
        c,
        404,
        "JOB_NOT_FOUND",
        "job not found"
      );
    }

    engine.cancel(
      job.id
    );

    logger.info(
      "job.cancel.requested",
      {
        jobId: job.id
      }
    );

    return c.json({
      ok: true,
      status:
        "cancelled"
    });
  }
);

app.get(
  "/v1/jobs/:id/download",
  async c => {
    const job =
      engine.getJob(
        c.req.param("id")
      );

    if (!job) {
      return apiError(
        c,
        404,
        "JOB_NOT_FOUND",
        "job not found"
      );
    }

    if (
      job.status !==
        "completed" ||
      !job.outputPath ||
      !job.outputName
    ) {
      return apiError(
        c,
        404,
        "OUTPUT_NOT_READY",
        "output not ready"
      );
    }

    const fileInfo =
      await stat(
        job.outputPath
      );

    const extension =
      job.outputName
        .split(".")
        .pop()
        ?.toLowerCase() ?? "";

    const contentTypes = {
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      wav: "audio/wav",
      flac: "audio/flac",
      ogg: "audio/ogg"
    };

    const contentType =
      contentTypes[
        extension as keyof typeof contentTypes
      ] ??
      "application/octet-stream";

    const stream =
      createReadStream(
        job.outputPath
      );

    logger.info(
      "job.download.started",
      {
        jobId: job.id,
        outputName:
          job.outputName,
        sizeBytes:
          fileInfo.size
      }
    );

    return new Response(
      stream as any,
      {
        headers: {
          "Content-Type":
            contentType,
          "Content-Length":
            String(fileInfo.size),
          "Content-Disposition":
            `attachment; filename="${job.outputName}"`,
          "X-DNYF-Job-ID":
            job.id
        }
      }
    );
  }
);

serve({
  fetch: app.fetch,
  hostname: host,
  port
});

logger.info(
  "server.started",
  {
    host,
    port
  },
  `DNYF Media API listening on http://${host}:${port}`
);
