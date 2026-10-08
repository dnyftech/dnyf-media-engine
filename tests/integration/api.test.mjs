import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

const API = "http://127.0.0.1:8787";
const INPUT = "data/test/input.mp4";

async function json(response) {
  const text = await response.text();

  assert.ok(
    text.length > 0,
    `Expected JSON response, received empty body (HTTP ${response.status})`
  );

  return JSON.parse(text);
}

test("DNYF Media API integration", async () => {
  // 1. Health
  const healthResponse = await fetch(`${API}/health`);

  assert.equal(healthResponse.status, 200);

  const health = await json(healthResponse);

  assert.equal(health.ok, true);
  assert.equal(health.service, "dnyf-media-api");

  // 2. Input
  const input = await readFile(INPUT);

  assert.ok(input.length > 0, "Test input video is empty");

  // 3. Upload + extraction request
  const form = new FormData();

  form.append(
    "file",
    new Blob([input], { type: "video/mp4" }),
    basename(INPUT)
  );

  form.append("format", "mp3");

  const extractResponse = await fetch(
    `${API}/v1/media/extract`,
    {
      method: "POST",
      body: form
    }
  );

  assert.equal(
    extractResponse.status,
    202,
    `Expected 202, received ${extractResponse.status}`
  );

  const created = await json(extractResponse);

  assert.ok(created.jobId, "API did not return a job ID");

  const jobId = created.jobId;

  // 4. Poll job
  const timeout = Date.now() + 30_000;

  let job;

  while (Date.now() < timeout) {
    const response = await fetch(
      `${API}/v1/jobs/${jobId}`
    );

    assert.equal(response.status, 200);

    job = await json(response);

    if (
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      break;
    }

    await new Promise(resolve =>
      setTimeout(resolve, 250)
    );
  }

  assert.ok(job, "No job response received");

  assert.equal(
    job.status,
    "completed",
    `Conversion did not complete: ${job.error ?? job.status}`
  );

  assert.equal(job.progress, 100);

  assert.ok(job.outputName);
  assert.ok(job.outputPath);

  // 5. Verify output on disk
  const output = await stat(job.outputPath);

  assert.ok(
    output.isFile(),
    "Output path is not a file"
  );

  assert.ok(
    output.size > 0,
    "Generated audio file is empty"
  );

  // 6. Verify download endpoint
  const downloadResponse = await fetch(
    `${API}/v1/jobs/${jobId}/download`
  );

  assert.equal(downloadResponse.status, 200);
  assert.equal(
    downloadResponse.headers.get("content-type"),
    "audio/mpeg"
  );
  assert.equal(
    downloadResponse.headers.get("content-length"),
    String(output.size)
  );
  assert.equal(
    downloadResponse.headers.get("x-dnyf-job-id"),
    jobId
  );
  assert.match(
    downloadResponse.headers.get("content-disposition") ?? "",
    /^attachment; filename="/
  );

  const downloaded = Buffer.from(
    await downloadResponse.arrayBuffer()
  );

  assert.ok(
    downloaded.length > 0,
    "Downloaded audio is empty"
  );

  assert.equal(
    downloaded.length,
    output.size,
    "Downloaded size does not match output size"
  );

  console.log(
    `Integration job ${jobId}: ${output.size} bytes`
  );
});
