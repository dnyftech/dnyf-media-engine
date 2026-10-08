import { spawn } from "node:child_process";
import { AUDIO_FORMATS, type AudioFormat, type MediaProbe } from "@dnyf/media-shared";

export interface FfmpegConfig {
  ffmpeg?: string;
  ffprobe?: string;
}

export interface ConvertRequest {
  inputPath: string;
  outputPath: string;
  format: AudioFormat;
  bitrate?: string;
  start?: string;
  duration?: string;
  onProgress?: (progress: number) => void;
  onProcess?: (pid: number) => void;
  signal?: AbortSignal;
}

const codecs: Record<AudioFormat, string[]> = {
  mp3: ["-c:a", "libmp3lame"],
  m4a: ["-c:a", "aac"],
  wav: ["-c:a", "pcm_s16le"],
  flac: ["-c:a", "flac"],
  ogg: ["-c:a", "libopus"]
};

export class FfmpegAdapter {
  private readonly ffmpeg: string;
  private readonly ffprobe: string;

  constructor(config: FfmpegConfig = {}) {
    this.ffmpeg =
      config.ffmpeg ??
      process.env.DNYF_FFMPEG_BIN ??
      "ffmpeg";

    this.ffprobe =
      config.ffprobe ??
      process.env.DNYF_FFPROBE_BIN ??
      "ffprobe";
  }

  probe(inputPath: string): Promise<MediaProbe> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffprobe, [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        inputPath
      ]);

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", data => {
        stdout += data.toString();
      });

      child.stderr.on("data", data => {
        stderr += data.toString();
      });

      child.on("error", reject);

      child.on("close", code => {
        if (code !== 0) {
          reject(new Error(stderr || "ffprobe failed"));
          return;
        }

        try {
          const parsed = JSON.parse(stdout);

          const video = parsed.streams?.find(
            (stream: any) => stream.codec_type === "video"
          );

          const audio = parsed.streams?.find(
            (stream: any) => stream.codec_type === "audio"
          );

          resolve({
            duration: parsed.format?.duration
              ? Number(parsed.format.duration)
              : undefined,
            format: parsed.format?.format_name,
            videoCodec: video?.codec_name,
            audioCodec: audio?.codec_name,
            sampleRate: audio?.sample_rate
              ? Number(audio.sample_rate)
              : undefined,
            channels: audio?.channels
          });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  convert(request: ConvertRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        "-hide_banner",
        "-y",

        ...(request.start
          ? ["-ss", request.start]
          : []),

        "-i",
        request.inputPath,

        ...(request.duration
          ? ["-t", request.duration]
          : []),

        "-vn",

        ...codecs[request.format],

        ...(request.bitrate &&
        request.format !== "wav" &&
        request.format !== "flac"
          ? ["-b:a", request.bitrate]
          : []),

        request.outputPath
      ];

      if (request.signal?.aborted) {
        reject(new Error("Conversion cancelled"));
        return;
      }

      const child = spawn(this.ffmpeg, args, {
        stdio: ["ignore", "pipe", "pipe"]
      });

      if (child.pid !== undefined) {
        request.onProcess?.(child.pid);
      }

      let settled = false;

      const settleReject = (error: Error): void => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      };

      const settleResolve = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        resolve();
      };

      let stderr = "";

      child.stderr.on("data", data => {
        stderr += data.toString();

        const match = stderr.match(
          /time=(\d+):(\d+):(\d+(?:\.\d+)?)/
        );

        if (match) {
          const seconds =
            Number(match[1]) * 3600 +
            Number(match[2]) * 60 +
            Number(match[3]);

          request.onProgress?.(
            Math.min(99, Math.max(1, Math.floor(seconds)))
          );
        }
      });

      const abort = () => {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      };

      request.signal?.addEventListener(
        "abort",
        abort,
        { once: true }
      );

      child.on("error", error => {
        settleReject(error);
      });

      child.on("close", code => {
        request.signal?.removeEventListener(
          "abort",
          abort
        );

        if (request.signal?.aborted) {
          settleReject(
            new Error("Conversion cancelled")
          );
          return;
        }

        if (code === 0) {
          settleResolve();
          return;
        }

        settleReject(
          new Error(
            stderr.slice(-4000) ||
            `ffmpeg exited with ${code}`
          )
        );
      });
    });
  }
}

export { MediaValidator } from "./validator.js";
export type {
  MediaValidatorConfig
} from "./validator.js";
