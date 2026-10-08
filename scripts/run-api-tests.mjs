import { spawn } from "node:child_process";
import process from "node:process";

const HOST = process.env.DNYF_TEST_API_HOST ?? "127.0.0.1";
const PORT = Number(process.env.DNYF_TEST_API_PORT ?? "8787");
const API_URL = `http://${HOST}:${PORT}`;
const API_ENTRY = "apps/api/dist/server.js";

const TEST_FILES = [
  "tests/integration/api.test.mjs",
  "tests/integration/api-security.test.mjs"
];

let server;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 15000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${API_URL}/health`);

      if (response.ok) {
        return;
      }
    } catch {
      // API is still starting.
    }

    await sleep(250);
  }

  throw new Error(
    `API did not become healthy within ${timeoutMs}ms: ${API_URL}`
  );
}

async function stopServer() {
  if (!server || server.exitCode !== null) {
    return;
  }

  server.kill("SIGTERM");

  await Promise.race([
    new Promise(resolve => server.once("exit", resolve)),
    sleep(3000)
  ]);

  if (server.exitCode === null) {
    server.kill("SIGKILL");
  }
}

async function runTest(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--test", file],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          DNYF_TEST_API_URL: API_URL
        }
      }
    );

    child.on("error", reject);

    child.on("exit", code => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${file} exited with code ${code ?? "unknown"}`
        )
      );
    });
  });
}

async function main() {
  console.log(`Starting test API: ${API_URL}`);

  server = spawn(
    process.execPath,
    [API_ENTRY],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        DNYF_API_HOST: HOST,
        DNYF_API_PORT: String(PORT)
      }
    }
  );

  server.on("error", error => {
    console.error("Failed to start API:", error);
  });

  await waitForHealth();

  console.log("Test API is healthy.");

  for (const file of TEST_FILES) {
    console.log(`\nRunning ${file}`);
    await runTest(file);
  }

  console.log("\nAPI integration verification passed.");
}

try {
  await main();
} finally {
  await stopServer();
}
