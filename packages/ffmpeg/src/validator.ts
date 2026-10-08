import { spawn } from "node:child_process";
import type { MediaValidationResult } from "@dnyf/media-shared";

export interface MediaValidatorConfig {
  ffprobe?: string;
}

const SUPPORTED_VIDEO_CODECS = new Set([
  "h264",
  "hevc",
  "vp8",
  "vp9",
  "av1",
  "mpeg4",
  "mpeg2video",
  "theora"
]);

const SUPPORTED_AUDIO_CODECS = new Set([
  "aac",
  "mp3",
  "opus",
  "vorbis",
  "flac",
  "pcm_s16le",
  "pcm_s24le",
  "pcm_s32le",
  "ac3",
  "eac3"
]);

export class MediaValidator {
  private readonly ffprobe: string;

  constructor(config: MediaValidatorConfig = {}) {
    this.ffprobe =
      config.ffprobe ??
      process.env.DNYF_FFPROBE_BIN ??
      "ffprobe";
  }

  validate(inputPath: string): Promise<MediaValidationResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffprobe, [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_error",
        "-show_format",
        "-show_streams",
        inputPath
      ], {
        stdio: ["ignore", "pipe", "pipe"]
      });

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
          resolve({
            valid: false,
            reason: stderr.trim() || "Unable to inspect media file."
          });
          return;
        }

        try {
          const parsed = JSON.parse(stdout);

          if (parsed.error) {
            resolve({
              valid: false,
              reason:
                parsed.error.string ||
                "Invalid media file."
            });
            return;
          }

          const streams = Array.isArray(parsed.streams)
            ? parsed.streams
            : [];

          const video = streams.find(
            (stream: any) =>
              stream.codec_type === "video"
          );

          const audio = streams.find(
            (stream: any) =>
              stream.codec_type === "audio"
          );

          if (!video) {
            resolve({
              valid: false,
              reason: "No video stream was found."
            });
            return;
          }

          if (
            video.codec_name &&
            !SUPPORTED_VIDEO_CODECS.has(
              video.codec_name
            )
          ) {
            resolve({
              valid: false,
              reason:
                `Unsupported video codec: ${video.codec_name}`
            });
            return;
          }

          if (
            audio?.codec_name &&
            !SUPPORTED_AUDIO_CODECS.has(
              audio.codec_name
            )
          ) {
            resolve({
              valid: false,
              reason:
                `Unsupported audio codec: ${audio.codec_name}`
            });
            return;
          }

          const duration = Number(
            parsed.format?.duration ??
            video.duration ??
            0
          );

          if (!Number.isFinite(duration) || duration <= 0) {
            resolve({
              valid: false,
              reason: "Media duration could not be determined."
            });
            return;
          }

          resolve({
            valid: true,
            duration,
            format: parsed.format?.format_name,
            videoCodec: video.codec_name,
            audioCodec: audio?.codec_name,
            sampleRate: audio?.sample_rate
              ? Number(audio.sample_rate)
              : undefined,
            channels: audio?.channels
          });
        } catch {
          resolve({
            valid: false,
            reason: "FFprobe returned invalid metadata."
          });
        }
      });
    });
  }
}
