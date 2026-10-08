export type LogLevel =
  | "debug"
  | "info"
  | "warn"
  | "error";

export interface LogContext {
  requestId?: string;
  jobId?: string;
  [key: string]: unknown;
}

export interface LogEntry extends LogContext {
  timestamp: string;
  level: LogLevel;
  service: string;
  event: string;
  message?: string;
}

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  private readonly service: string;
  private readonly minimumLevel: LogLevel;

  constructor(options: LoggerOptions) {
    this.service = options.service;
    this.minimumLevel = options.level ?? "info";
  }

  child(context: LogContext): Logger {
    const child = new Logger({
      service: this.service,
      level: this.minimumLevel
    });

    child.writeContext = {
      ...this.writeContext,
      ...context
    };

    return child;
  }

  private writeContext: LogContext = {};

  debug(
    event: string,
    context: LogContext = {},
    message?: string
  ): void {
    this.write("debug", event, context, message);
  }

  info(
    event: string,
    context: LogContext = {},
    message?: string
  ): void {
    this.write("info", event, context, message);
  }

  warn(
    event: string,
    context: LogContext = {},
    message?: string
  ): void {
    this.write("warn", event, context, message);
  }

  error(
    event: string,
    context: LogContext = {},
    message?: string
  ): void {
    this.write("error", event, context, message);
  }

  private write(
    level: LogLevel,
    event: string,
    context: LogContext,
    message?: string
  ): void {
    if (
      LEVEL_ORDER[level] <
      LEVEL_ORDER[this.minimumLevel]
    ) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      event,
      ...this.writeContext,
      ...context
    };

    if (message) {
      entry.message = message;
    }

    const output = JSON.stringify(entry);

    if (level === "error") {
      console.error(output);
    } else if (level === "warn") {
      console.warn(output);
    } else {
      console.log(output);
    }
  }
}

export function createLogger(
  service: string,
  level: LogLevel = "info"
): Logger {
  return new Logger({
    service,
    level
  });
}
