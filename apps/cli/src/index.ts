#!/usr/bin/env node

import { Command } from "commander";
import { AUDIO_FORMATS } from "@dnyf/media-shared";
import { readFile } from "node:fs/promises";

const program =
  new Command();

program
  .name("dnyf-media")
  .description(
    "DNYFTECH Media Engine"
  )
  .version("0.1.0");

program
  .command("formats")
  .description(
    "List supported formats"
  )
  .action(() => {
    console.log(
      AUDIO_FORMATS.join("\n")
    );
  });

program
  .command("extract")
  .argument("<file>")
  .option(
    "-f, --format <format>",
    "output format",
    "mp3"
  )
  .option(
    "-b, --bitrate <bitrate>",
    "audio bitrate",
    "192k"
  )
  .option(
    "-s, --start <time>",
    "start time"
  )
  .option(
    "-d, --duration <time>",
    "duration"
  )
  .option(
    "-u, --url <url>",
    "API URL",
    "http://127.0.0.1:8787"
  )
  .action(
    async (
      file,
      options
    ) => {
      const bytes =
        await readFile(file);

      const form =
        new FormData();

      form.append(
        "file",
        new Blob([bytes]),
        file.split("/").pop() ??
          "video"
      );

      form.append(
        "format",
        options.format
      );

      form.append(
        "bitrate",
        options.bitrate
      );

      if (options.start) {
        form.append(
          "start",
          options.start
        );
      }

      if (options.duration) {
        form.append(
          "duration",
          options.duration
        );
      }

      const response =
        await fetch(
          `${options.url}/v1/media/extract`,
          {
            method: "POST",
            body: form
          }
        );

      if (!response.ok) {
        throw new Error(
          await response.text()
        );
      }

      const result =
        await response.json();

      console.log(
        `Job: ${result.jobId}`
      );

      while (true) {
        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              1000
            )
        );

        const status =
          await fetch(
            `${options.url}/v1/jobs/${result.jobId}`
          ).then(
            response =>
              response.json()
          );

        process.stdout.write(
          `\r${status.status} ${status.progress ?? 0}%`
        );

        if (
          [
            "completed",
            "failed",
            "cancelled"
          ].includes(
            status.status
          )
        ) {
          process.stdout.write(
            "\n"
          );

          if (
            status.status !==
            "completed"
          ) {
            throw new Error(
              status.error ??
                status.status
            );
          }

          console.log(
            `Download: ${options.url}/v1/jobs/${result.jobId}/download`
          );

          break;
        }
      }
    }
  );

await program.parseAsync();
