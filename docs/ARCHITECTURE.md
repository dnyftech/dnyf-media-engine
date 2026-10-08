# DNYF Media Engine — Architecture & Operations Documentation

## Project

- Project: `dnyf-media-engine`
- Brand: DNYFTECH
- Canonical path: `~/DNYF-DEV/workspace/media/dnyf-media-engine`
- Package manager: pnpm
- Runtime: Node.js + TypeScript ESM
- Media backend: FFmpeg / ffprobe
- CLI: `dnyf-media`

## Architecture

```text
dnyf-media-engine/
├── apps/
│   ├── api/
│   ├── cli/
│   └── web/
├── packages/
│   ├── shared/
│   ├── ffmpeg/
│   └── engine/
├── config/
├── data/
│   ├── uploads/
│   ├── outputs/
│   ├── jobs/
│   └── test/
├── docs/
├── scripts/
├── tests/
├── package.json
└── pnpm-workspace.yaml
```

## Supported Audio Formats

| Format | FFmpeg codec |
|---|---|
| MP3 | `libmp3lame` |
| M4A | `aac` |
| WAV | `pcm_s16le` |
| FLAC | `flac` |
| OGG | `libopus` |

## Job Lifecycle

```text
queued → probing → converting → completed
                         ├────→ failed
                         └────→ cancelled
```

The engine implements persistent job metadata, restart recovery, queue limits, concurrent-job limits, AbortController cancellation, FFmpeg SIGTERM cancellation, progress reporting, safe filenames, output-size tracking, and structured JSON logging.

Default limits:

```text
maxConcurrentJobs = 1
maxQueuedJobs      = 4
```

## Shared Package

`@dnyf/media-shared` provides domain types, audio formats, job statuses, extraction options, media probes, API errors, media validation, `MediaError`, and structured logging.

Logger levels:

```text
debug
info
warn
error
```

Configure:

```bash
export DNYF_LOG_LEVEL=debug
```

## FFmpeg Package

`@dnyf/media-ffmpeg` isolates FFmpeg and ffprobe operations.

Capabilities include probing, codec validation, audio extraction, start/duration selection, bitrate configuration, progress parsing, process cancellation, and PID reporting.

Optional executable configuration:

```bash
export DNYF_FFMPEG_BIN=/path/to/ffmpeg
export DNYF_FFPROBE_BIN=/path/to/ffprobe
```

## Media Validation

Accepted input extensions:

```text
mp4 m4v mov mkv webm avi flv wmv mpeg mpg 3gp ts
```

Validation occurs before conversion.

## API

Default runtime:

```text
Host: 127.0.0.1
Port: 8787
```

Endpoints:

```text
GET  /health
GET  /ready
POST /v1/media/extract
GET  /v1/jobs/:id
POST /v1/jobs/:id/cancel
GET  /v1/jobs/:id/download
```

Extraction accepts multipart media and parameters such as:

```text
format
bitrate
start
duration
```

Downloads expose controlled media headers and never expose arbitrary filesystem paths.

## API Hardening

Implemented protections:

- explicit CORS
- empty-upload rejection
- maximum upload-size enforcement
- output-format validation
- input-extension allowlist
- filename sanitization
- filesystem free-space checks
- controlled download paths
- structured API errors
- request IDs
- graceful shutdown
- queue-capacity enforcement

Error codes include:

```text
FILE_REQUIRED
FILE_EMPTY
FILE_TOO_LARGE
UNSUPPORTED_FORMAT
UNSUPPORTED_INPUT
INSUFFICIENT_STORAGE
JOB_QUEUE_FULL
CONVERSION_FAILED
JOB_NOT_FOUND
OUTPUT_NOT_READY
```

## Configuration

Important environment variables:

```text
DNYF_HOST
DNYF_PORT
DNYF_DATA_DIR
DNYF_MAX_UPLOAD_MB
DNYF_MIN_FREE_MB
DNYF_CORS_ORIGINS
DNYF_MAX_CONCURRENT_JOBS
DNYF_MAX_QUEUED_JOBS
DNYF_LOG_LEVEL
DNYF_SHUTDOWN_TIMEOUT_MS
```

Current defaults:

```text
Host: 127.0.0.1
Port: 8787
Maximum upload: 2048 MB
Minimum free storage: 512 MB
Concurrent jobs: 1
Queued jobs: 4
Shutdown timeout: 15000 ms
```

## CLI

Wrapper:

```text
~/DNYF-DEV/bin/dnyf-media
```

Commands:

```bash
dnyf-media formats
dnyf-media extract <video> --format mp3
```

## Build and Verification

```bash
cd ~/DNYF-DEV/workspace/media/dnyf-media-engine
pnpm install
pnpm build
pnpm verify
```

Latest verified baseline:

```text
Engine tests:          4/4 PASS
FFmpeg cancellation:   1/1 PASS
API integration:       1/1 PASS
API security:          12/12 PASS
Graceful shutdown:     PASS
Structured logs:       PASS
Request IDs:            PASS
```

## Storage Cleanup

```bash
pnpm cleanup:storage
pnpm cleanup:storage:apply
```

Default retention is 24 hours. Cleanup covers jobs, uploads, and outputs while protecting referenced outputs.

## Test Media

Synthetic fixture:

```text
data/test/input.mp4
```

Example generation:

```bash
ffmpeg \\
  -f lavfi -i "testsrc=size=320x240:rate=30" \\
  -f lavfi -i "sine=frequency=1000:sample_rate=44100" \\
  -t 5 \\
  -c:v libx264 \\
  -c:a aac \\
  -pix_fmt yuv420p \\
  data/test/input.mp4
```

## Runtime Commands

```bash
cd ~/DNYF-DEV/workspace/media/dnyf-media-engine
pnpm --filter @dnyf/media-api dev
node apps/api/dist/server.js
dnyf-media formats
dnyf-media extract data/test/input.mp4 --format mp3
pnpm verify
```

## Graceful Shutdown

The API handles `SIGTERM` and `SIGINT`.

```text
signal received
    ↓
readiness disabled
    ↓
HTTP server closes
    ↓
shutdown duration recorded
    ↓
process exits
```

Events:

```text
server.shutdown.started
server.shutdown.completed
server.shutdown.failed
```

## Production Direction

```text
Client → Web/API → validation → job queue → media engine → FFmpeg → persistent output → controlled download
```

Planned increments:

1. Engine metrics: active jobs, queue depth, completed/failed/cancelled totals, conversion duration, output bytes, capacity utilization.
2. API metrics endpoint.
3. Rate limiting.
4. CI verification.
5. Production configuration.
6. Cloudflare exposure.
7. Persistent database where required.
8. Object storage for large workloads.

## Resource Constraints

The primary development environment is Android/Termux arm64 with constrained storage and memory.

Operational rules:

- avoid duplicate dependency stores
- use the centralized pnpm store
- avoid unnecessary build artifacts
- use cleanup scripts
- limit concurrent FFmpeg jobs
- enforce upload-size limits
- enforce minimum free storage
- keep test fixtures small
- prefer reproducible builds

Central pnpm store:

```text
~/DNYF-DEV/pnpm-store
```

Configure:

```bash
pnpm config set store-dir "$HOME/DNYF-DEV/pnpm-store"
```

## Git Workflow

Preferred branch:

```text
master
```

```bash
git status --short --branch
git log --oneline -10
git add README.md docs/ARCHITECTURE.md
git commit -m "docs: document media engine architecture"
git push origin master
```

Only stage intended documentation files; do not stage unrelated parent-workspace changes.

## Design Principle

Responsibilities are separated:

```text
shared → ffmpeg → engine → api → web / cli
```

This keeps domain types, media processing, job orchestration, HTTP handling, CLI operations, and web presentation modular and independently maintainable.

DNYF Media Engine is structured as a production-oriented media-processing platform rather than a single-purpose conversion script.
