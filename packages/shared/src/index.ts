export const AUDIO_FORMATS = [
  "mp3",
  "m4a",
  "wav",
  "flac",
  "ogg"
] as const;

export type AudioFormat = typeof AUDIO_FORMATS[number];

export const JOB_STATUSES = [
  "queued",
  "probing",
  "converting",
  "completed",
  "failed",
  "cancelled"
] as const;

export type JobStatus = typeof JOB_STATUSES[number];

export interface ExtractOptions {
  format: AudioFormat;
  bitrate?: string;
  start?: string;
  duration?: string;
}
export interface MediaJob {
  id: string;
  status: JobStatus;
  progress: number;
  inputName: string;
  outputName?: string;
  outputPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MediaProbe {
  duration?: number;
  format?: string;
  videoCodec?: string;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    status: number;
    details?: Record<string, unknown>;
  };
}

export class MediaError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "MediaError";
  }
}

export function assertAudioFormat(
  value: string
): asserts value is AudioFormat {
  if (!AUDIO_FORMATS.includes(value as AudioFormat)) {
    throw new MediaError(
      `Unsupported audio format: ${value}`,
      "UNSUPPORTED_FORMAT"
    );
  }
}

export type {
  MediaValidationResult
} from "./media-validation.js";


export {
  Logger,
  createLogger
} from "./logger.js";

export type {
  LogLevel,
  LogContext,
  LogEntry,
  LoggerOptions
} from "./logger.js";
