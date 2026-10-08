import {
  readdir,
  readFile,
  unlink,
  stat
} from "node:fs/promises";
import { join } from "node:path";

const root =
  process.env.DNYF_MEDIA_DATA_DIR ??
  join(process.cwd(), "data");

const retentionHours = Number(
  process.env.DNYF_MEDIA_RETENTION_HOURS ?? 24
);

const dryRun =
  process.env.DNYF_MEDIA_CLEANUP_DRY_RUN !== "0";

const cutoff =
  Date.now() -
  retentionHours * 60 * 60 * 1000;

const jobsDir = join(root, "jobs");
const uploadsDir = join(root, "uploads");
const outputsDir = join(root, "outputs");

let removedJobs = 0;
let removedUploads = 0;
let removedOutputs = 0;

async function filesIn(dir) {
  try {
    return await readdir(dir, {
      withFileTypes: true
    });
  } catch {
    return [];
  }
}

async function removeFile(path, label) {
  if (dryRun) {
    console.log(`[dry-run] remove ${label}: ${path}`);
    return;
  }

  await unlink(path);
  console.log(`removed ${label}: ${path}`);
}

async function loadJobs() {
  const jobs = new Map();

  for (const entry of await filesIn(jobsDir)) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".json")
    ) {
      continue;
    }

    const path = join(jobsDir, entry.name);

    try {
      const job = JSON.parse(
        await readFile(path, "utf8")
      );

      if (job.id) {
        jobs.set(job.id, job);
      }
    } catch {
      console.warn(
        `Skipping invalid job metadata: ${path}`
      );
    }
  }

  return jobs;
}

async function cleanupJobs(jobs) {
  for (const entry of await filesIn(jobsDir)) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".json")
    ) {
      continue;
    }

    const path = join(jobsDir, entry.name);

    try {
      const job = JSON.parse(
        await readFile(path, "utf8")
      );

      const updatedAt =
        Date.parse(job.updatedAt ?? "");

      if (
        Number.isFinite(updatedAt) &&
        updatedAt < cutoff &&
        ["completed", "failed", "cancelled"].includes(
          job.status
        )
      ) {
        await removeFile(
          path,
          "job"
        );

        removedJobs++;
      }
    } catch {
      // Invalid metadata is intentionally left untouched.
    }
  }
}

async function cleanupReferencedOutputs(jobs) {
  const referenced = new Set();

  for (const job of jobs.values()) {
    if (job.outputPath) {
      referenced.add(job.outputPath);
    }
  }

  for (const entry of await filesIn(outputsDir)) {
    if (!entry.isFile()) continue;

    const path = join(outputsDir, entry.name);

    if (referenced.has(path)) continue;

    const info = await stat(path);

    if (info.mtimeMs < cutoff) {
      await removeFile(
        path,
        "orphaned output"
      );

      removedOutputs++;
    }
  }
}

async function cleanupUploads() {
  for (const entry of await filesIn(uploadsDir)) {
    if (!entry.isFile()) continue;

    const path = join(uploadsDir, entry.name);
    const info = await stat(path);

    if (info.mtimeMs < cutoff) {
      await removeFile(
        path,
        "stale upload"
      );

      removedUploads++;
    }
  }
}

const jobs = await loadJobs();

console.log("DNYF Media Engine storage cleanup");
console.log(`data: ${root}`);
console.log(`retention: ${retentionHours}h`);
console.log(`mode: ${dryRun ? "dry-run" : "delete"}`);
console.log();

await cleanupJobs(jobs);
await cleanupReferencedOutputs(jobs);
await cleanupUploads();

console.log();
console.log(
  `jobs: ${removedJobs} | uploads: ${removedUploads} | outputs: ${removedOutputs}`
);
