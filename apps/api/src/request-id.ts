import { randomUUID } from "node:crypto";

export function createRequestId(
  supplied?: string | null
): string {
  if (
    supplied &&
    /^[A-Za-z0-9._-]{1,128}$/.test(supplied)
  ) {
    return supplied;
  }

  return randomUUID();
}
