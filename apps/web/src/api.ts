export interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
    status?: number;
    details?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code = "API_ERROR",
    status = 500,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export async function parseApiError(
  response: Response
): Promise<ApiError> {
  try {
    const payload =
      (await response.json()) as ApiErrorPayload;

    return new ApiError(
      payload.error?.message ??
        `Request failed with status ${response.status}`,
      payload.error?.code ??
        "API_ERROR",
      payload.error?.status ??
        response.status,
      payload.error?.details
    );
  } catch {
    return new ApiError(
      `Request failed with status ${response.status}`,
      "API_ERROR",
      response.status
    );
  }
}

export function userMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error
      ? error.message
      : "An unexpected error occurred.";
  }

  switch (error.code) {
    case "FILE_REQUIRED":
      return "Select a video file first.";

    case "FILE_EMPTY":
      return "The selected file is empty.";

    case "FILE_TOO_LARGE":
      return "The selected video is too large.";

    case "UNSUPPORTED_FORMAT":
      return "That audio format is not supported.";

    case "UNSUPPORTED_INPUT":
      return "That video format is not supported.";

    case "INSUFFICIENT_STORAGE":
      return "There is not enough storage space for this conversion.";

    case "JOB_QUEUE_FULL":
      return "The conversion queue is full. Please try again shortly.";

    case "JOB_NOT_FOUND":
      return "The conversion job could not be found.";

    case "OUTPUT_NOT_READY":
      return "The converted audio is not ready yet.";

    case "CONVERSION_FAILED":
      return "The video could not be converted.";

    default:
      return error.message;
  }
}
