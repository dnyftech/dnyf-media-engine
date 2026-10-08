import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const API_URL = process.env.DNYF_TEST_API_URL ?? "http://127.0.0.1:8787";
const DATA_DIR = path.join(ROOT, "data", "test", "security");
const FIXTURES = path.join(DATA_DIR, "fixtures");

let server;
let serverStarted = false;

async function waitForHealth(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_URL}/health`);

      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet.
    }

    await new Promise(resolve => setTimeout(resolve, 150));
  }

  throw new Error(`API did not become healthy at ${API_URL}`);
}

async function ensureServer() {
  try {
    const response = await fetch(`${API_URL}/health`);

    if (response.ok) {
      return;
    }
  } catch {
    // Start local test server below.
  }

  server = spawn(
    process.execPath,
    ["apps/api/dist/server.js"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: "8787"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});

  serverStarted = true;

  await waitForHealth();
}

async function postMultipart(fields = {}) {
  const form = new FormData();

  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }

  return fetch(`${API_URL}/v1/media/extract`, {
    method: "POST",
    body: form
  });
}

async function uploadFile(filePath, filename, format = "mp3") {
  const bytes = await fs.readFile(filePath);

  const form = new FormData();

  form.append(
    "file",
    new Blob([bytes], { type: "video/mp4" }),
    filename
  );

  form.append("format", format);

  return fetch(`${API_URL}/v1/media/extract`, {
    method: "POST",
    body: form
  });
}

async function json(response) {
  return response.json();
}

async function pollJob(jobId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(
      `${API_URL}/v1/jobs/${encodeURIComponent(jobId)}`
    );

    assert.equal(response.status, 200);

    const body = await response.json();

    if (
      ["completed", "failed", "cancelled"].includes(
        body.status
      )
    ) {
      return body;
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for job ${jobId}`);
}

before(async () => {
  await fs.mkdir(FIXTURES, { recursive: true });

  await ensureServer();

  await fs.writeFile(
    path.join(FIXTURES, "empty.mp4"),
    Buffer.alloc(0)
  );

  await fs.writeFile(
    path.join(FIXTURES, "corrupt.mp4"),
    Buffer.from(
      "This is not a real media container."
    )
  );

  await fs.writeFile(
    path.join(FIXTURES, "document.txt"),
    Buffer.from("not media")
  );
});

after(async () => {
  if (serverStarted && server) {
    server.kill("SIGTERM");
  }

  await fs.rm(DATA_DIR, {
    recursive: true,
    force: true
  });
});

test("rejects request with no file", async () => {
  const response = await postMultipart({
    format: "mp3"
  });

  assert.equal(response.status, 400);

  const body = await json(response);

  assert.equal(
    body.error?.code,
    "FILE_REQUIRED"
  );
});

test("rejects an empty upload", async () => {
  const response = await uploadFile(
    path.join(FIXTURES, "empty.mp4"),
    "empty.mp4"
  );

  assert.equal(response.status, 400);

  const body = await json(response);

  assert.equal(
    body.error?.code,
    "FILE_EMPTY"
  );
});

test("rejects an unsupported input extension", async () => {
  const response = await uploadFile(
    path.join(FIXTURES, "document.txt"),
    "document.txt"
  );

  assert.equal(response.status, 400);

  const body = await json(response);

  assert.equal(
    body.error?.code,
    "UNSUPPORTED_INPUT"
  );
});

test("rejects corrupt media instead of sending it to conversion", async () => {
  const response = await uploadFile(
    path.join(FIXTURES, "corrupt.mp4"),
    "corrupt.mp4"
  );

  assert.equal(response.status, 202);

  const body = await json(response);

  assert.ok(body.jobId);

  const job = await pollJob(body.jobId);

  assert.equal(job.status, "failed");
  assert.match(
    job.error ?? "",
    /invalid|media|metadata|video|ffprobe/i
  );
});

test("rejects an unsupported output format", async () => {
  const response = await postMultipart({
    file: new Blob(
      [await fs.readFile(
        path.join(ROOT, "data", "test", "input.mp4")
      )],
      { type: "video/mp4" }
    ),
    format: "exe"
  });

  assert.equal(response.status, 400);

  const body = await json(response);

  assert.equal(
    body.error?.code,
    "UNSUPPORTED_FORMAT"
  );
});

test("rejects malformed output format variants", async () => {
  const response = await uploadFile(
    path.join(ROOT, "data", "test", "input.mp4"),
    "input.mp4",
    "mp3x"
  );

  assert.equal(response.status, 400);

  const body = await json(response);

  assert.equal(
    body.error?.code,
    "UNSUPPORTED_FORMAT"
  );
});

test("returns 404 for a nonexistent job", async () => {
  const response = await fetch(
    `${API_URL}/v1/jobs/job_does_not_exist`
  );

  assert.equal(response.status, 404);

  const body = await json(response);

  assert.equal(
    body.error?.code,
    "JOB_NOT_FOUND"
  );
});

test("returns 404 for a nonexistent job download", async () => {
  const response = await fetch(
    `${API_URL}/v1/jobs/job_does_not_exist/download`
  );

  assert.equal(response.status, 404);

  const body = await json(response);

  assert.equal(
    body.error?.code,
    "JOB_NOT_FOUND"
  );
});

test("sanitizes traversal-style filenames", async () => {
  const response = await uploadFile(
    path.join(ROOT, "data", "test", "input.mp4"),
    "../../outside.mp4"
  );

  assert.equal(response.status, 202);

  const body = await json(response);

  assert.ok(body.jobId);

  const job = await pollJob(body.jobId);

  assert.equal(job.status, "completed");

  assert.ok(job.inputName);
  assert.ok(!job.inputName.includes("/"));
  assert.ok(!job.inputName.includes("\\"));
  assert.ok(!job.inputName.includes(".."));

  const outputPath = job.outputPath;

  assert.ok(outputPath);

  const resolvedOutput = path.resolve(outputPath);
  const outputsRoot = path.resolve(
    ROOT,
    "data",
    "outputs"
  );

  assert.ok(
    resolvedOutput === outputsRoot ||
      resolvedOutput.startsWith(`${outputsRoot}${path.sep}`)
  );
});

test("does not expose arbitrary filesystem paths through download", async () => {
  const response = await fetch(
    `${API_URL}/v1/jobs/../../etc/passwd/download`
  );

  assert.ok(
    response.status === 404 ||
      response.status === 400
  );
});

test("completed job exposes a controlled download", async () => {
  const response = await uploadFile(
    path.join(ROOT, "data", "test", "input.mp4"),
    "download-check.mp4"
  );

  assert.equal(response.status, 202);

  const body = await json(response);

  const job = await pollJob(body.jobId);

  assert.equal(job.status, "completed");

  const download = await fetch(
    `${API_URL}/v1/jobs/${encodeURIComponent(
      body.jobId
    )}/download`
  );

  assert.equal(download.status, 200);

  assert.equal(
    download.headers.get("x-dnyf-job-id"),
    body.jobId
  );

  assert.match(
    download.headers.get("content-disposition") ?? "",
    /attachment/i
  );

  assert.match(
    download.headers.get("content-type") ?? "",
    /^audio\//
  );
});

test("cancellation reaches a terminal cancelled state", async () => {
  const response = await uploadFile(
    path.join(ROOT, "data", "test", "cancellation-input.mp4"),
    "cancel-test.mp4"
  );

  assert.equal(response.status, 202);

  const body = await json(response);

  assert.ok(body.jobId);

  const cancel = await fetch(
    `${API_URL}/v1/jobs/${encodeURIComponent(
      body.jobId
    )}/cancel`,
    {
      method: "POST"
    }
  );

  assert.ok(
    cancel.status === 200 ||
      cancel.status === 202
  );

  const job = await pollJob(
    body.jobId,
    10000
  );

  assert.equal(job.status, "cancelled");
});
