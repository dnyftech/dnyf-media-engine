import process from "node:process";

function numberEnv(
  name: string,
  fallback: number
): number {
  const value = Number(process.env[name]);

  return Number.isFinite(value)
    ? value
    : fallback;
}

export const apiConfig = {
  host:
    process.env.DNYF_API_HOST ??
    "127.0.0.1",

  port: numberEnv(
    "DNYF_API_PORT",
    8787
  ),

  logLevel:
    (process.env.DNYF_LOG_LEVEL ??
      "info") as
      | "debug"
      | "info"
      | "warn"
      | "error",

  shutdownTimeoutMs:
    numberEnv(
      "DNYF_SHUTDOWN_TIMEOUT_MS",
      15000
    )
};
