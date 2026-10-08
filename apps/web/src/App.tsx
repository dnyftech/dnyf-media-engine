import {
  ChangeEvent,
  DragEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import {
  parseApiError,
  userMessage
} from "./api";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ??
  "http://127.0.0.1:8787";

const FORMATS = [
  { id: "mp3", label: "MP3", description: "Universal compatibility" },
  { id: "m4a", label: "M4A", description: "Efficient AAC audio" },
  { id: "wav", label: "WAV", description: "Uncompressed audio" },
  { id: "flac", label: "FLAC", description: "Lossless audio" },
  { id: "ogg", label: "OGG", description: "Open audio format" }
] as const;

type Format = (typeof FORMATS)[number]["id"];

const MAX_FILE_BYTES = 2048 * 1024 * 1024;

const SUPPORTED_INPUT_EXTENSIONS = new Set([
  "mp4",
  "m4v",
  "mov",
  "mkv",
  "webm",
  "avi",
  "flv",
  "wmv",
  "mpeg",
  "mpg",
  "3gp",
  "ts"
]);

const BITRATE_FORMATS = new Set<Format>([
  "mp3",
  "m4a",
  "ogg"
]);

function getFileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index === -1
    ? ""
    : name.slice(index + 1).toLowerCase();
}

function isBitrateFormat(value: Format): boolean {
  return BITRATE_FORMATS.has(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function jobStatusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "Queued";

    case "probing":
      return "Analyzing video";

    case "converting":
      return "Converting audio";

    case "completed":
      return "Conversion complete";

    case "failed":
      return "Conversion failed";

    case "cancelled":
      return "Conversion cancelled";

    default:
      return status;
  }
}

type Job = {
  id: string;
  status: string;
  progress: number;
  inputName: string;
  outputName?: string;
  error?: string;
};

function App() {
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<Format>("mp3");
  const [bitrate, setBitrate] = useState("192k");
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");

  const selectedFormat = useMemo(
    () => FORMATS.find((item) => item.id === format)!,
    [format]
  );

  useEffect(() => {
    if (!isBitrateFormat(format)) {
      setBitrate("");
    } else if (!bitrate) {
      setBitrate("192k");
    }
  }, [format]);

  useEffect(() => {
    if (!job) return;

    if (
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      setBusy(false);
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `${API_BASE}/v1/jobs/${job.id}`
        );

        if (!response.ok) {
          throw await parseApiError(response);
        }

        const nextJob = (await response.json()) as Job;
        setJob(nextJob);
      } catch (err) {
        setError(userMessage(err));
        setBusy(false);
      }
    }, 700);

    return () => window.clearTimeout(timer);
  }, [job]);

  function chooseFile(nextFile: File | null) {
    setError("");
    setJob(null);

    if (!nextFile) {
      setFile(null);
      return;
    }

    if (nextFile.size === 0) {
      setFile(null);
      setError("The selected video is empty.");
      return;
    }

    if (nextFile.size > MAX_FILE_BYTES) {
      setFile(null);
      setError(
        `The selected video is too large. Maximum size is ${formatBytes(MAX_FILE_BYTES)}.`
      );
      return;
    }

    const extension = getFileExtension(nextFile.name);

    if (
      !extension ||
      !SUPPORTED_INPUT_EXTENSIONS.has(extension)
    ) {
      setFile(null);
      setError(
        "That video format is not supported. Choose MP4, MKV, MOV, WebM, AVI, FLV, WMV, MPEG, MPG, 3GP, or TS."
      );
      return;
    }

    setFile(nextFile);
  }

  function handleFileInput(
    event: ChangeEvent<HTMLInputElement>
  ) {
    chooseFile(event.target.files?.[0] ?? null);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function startConversion() {
    if (!file) {
      setError("Select a video first.");
      return;
    }

    setBusy(true);
    setError("");
    setJob(null);

    try {
      const body = new FormData();
      body.append("file", file);
      body.append("format", format);

      if (
        isBitrateFormat(format) &&
        bitrate.trim()
      ) {
        body.append("bitrate", bitrate.trim());
      }

      const response = await fetch(
        `${API_BASE}/v1/media/extract`,
        {
          method: "POST",
          body
        }
      );

      if (!response.ok) {
        throw await parseApiError(response);
      }

      const data = await response.json();

      setJob({
        id: data.jobId,
        status: data.status,
        progress: 0,
        inputName: file.name
      });
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        "details" in err
      ) {
        const apiError = err as {
          code?: string;
          details?: Record<string, unknown>;
        };

        if (
          apiError.code === "FILE_TOO_LARGE" &&
          typeof apiError.details?.maxBytes === "number"
        ) {
          setError(
            `The selected video is too large. Maximum size is ${formatBytes(
              apiError.details.maxBytes
            )}.`
          );
        } else if (
          apiError.code === "INSUFFICIENT_STORAGE" &&
          typeof apiError.details?.availableBytes === "number" &&
          typeof apiError.details?.requiredBytes === "number"
        ) {
          setError(
            `Not enough storage. Available: ${formatBytes(
              apiError.details.availableBytes
            )}; required: ${formatBytes(
              apiError.details.requiredBytes
            )}.`
          );
        } else {
          setError(userMessage(err));
        }
      } else {
        setError(userMessage(err));
      }

      setBusy(false);
    }
  }

  async function cancelConversion() {
    if (!job) return;

    try {
      const response = await fetch(
        `${API_BASE}/v1/jobs/${job.id}/cancel`,
        { method: "POST" }
      );

      if (!response.ok) {
        throw await parseApiError(response);
      }

      setJob(await response.json());
      setBusy(false);
    } catch (err) {
      setError(userMessage(err));
    }
  }

  function downloadResult() {
    if (!job) return;

    window.location.href =
      `${API_BASE}/v1/jobs/${job.id}/download`;
  }

  const isCompleted = job?.status === "completed";

  return (
    <main className="page">
      <section className="shell">
        <header className="header">
          <div>
            <div className="eyebrow">DNYFTECH</div>
            <h1>DNYF Media Engine</h1>
            <p>
              Convert video files into clean, downloadable audio.
            </p>
          </div>

          <div className="status-pill">
            <span />
            Local Engine
          </div>
        </header>

        <section className="workspace">
          <div
            className={`drop-zone ${dragging ? "dragging" : ""} ${
              file ? "has-file" : ""
            }`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              accept="video/*,.mp4,.mkv,.mov,.webm,.avi,.flv,.wmv,.mpeg,.mpg,.3gp,.ts"
              hidden
              onChange={handleFileInput}
            />

            <div className="upload-icon">↑</div>

            {file ? (
              <>
                <strong>{file.name}</strong>
                <span>
                  {formatBytes(file.size)} · {getFileExtension(file.name).toUpperCase()}
                </span>
              </>
            ) : (
              <>
                <strong>Drop a video here</strong>
                <span>or tap to choose a video file</span>
              </>
            )}
          </div>

          <div className="controls">
            <div className="field">
              <label>Audio format</label>

              <div className="format-grid">
                {FORMATS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={
                      format === item.id
                        ? "format selected"
                        : "format"
                    }
                    onClick={() => setFormat(item.id)}
                    disabled={busy}
                  >
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label htmlFor="bitrate">Bitrate</label>

              <select
                id="bitrate"
                value={bitrate}
                onChange={(event) =>
                  setBitrate(event.target.value)
                }
                disabled={busy}
              >
                <option value="128k">128 kbps</option>
                <option value="192k">192 kbps</option>
                <option value="256k">256 kbps</option>
                <option value="320k">320 kbps</option>
              </select>
            </div>

            <button
              className="primary"
              type="button"
              disabled={!file || busy}
              onClick={startConversion}
            >
              {busy ? "Converting…" : `Convert to ${selectedFormat.label}`}
            </button>
          </div>

          {error && (
            <div className="error">
              {error}
            </div>
          )}

          {job && (
            <section className="job-card">
              <div className="job-header">
                <div>
                  <span className="job-label">CONVERSION JOB</span>
                  <strong>{job.inputName}</strong>
                </div>

                <span className={`job-status ${job.status}`}>
                  {jobStatusLabel(job.status)}
                </span>
              </div>

              <div className="progress-track">
                <div
                  className="progress-bar"
                  style={{
                    width: `${Math.max(
                      0,
                      Math.min(100, job.progress)
                    )}%`
                  }}
                />
              </div>

              <div className="progress-meta">
                <span>{Math.round(job.progress)}%</span>
                <span>{job.id}</span>
              </div>

              {job.error && (
                <div className="error">
                  {job.error}
                </div>
              )}

              <div className="job-actions">
                {busy && (
                  <button
                    className="secondary danger"
                    type="button"
                    onClick={cancelConversion}
                  >
                    Cancel
                  </button>
                )}

                {isCompleted && (
                  <button
                    className="primary"
                    type="button"
                    onClick={downloadResult}
                  >
                    Download {job.outputName ?? "audio"}
                  </button>
                )}
              </div>
            </section>
          )}
        </section>

        <footer>
          DNYF Media Engine <span>•</span> Powered by FFmpeg
        </footer>
      </section>
    </main>
  );
}

export default App;
