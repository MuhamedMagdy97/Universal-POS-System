/**
 * Structured JSON logger. One line per event with `requestId`, `orgId` and
 * `actor` context. Values under secret-looking keys are always redacted.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = {
  requestId?: string;
  orgId?: string;
  actor?: string;
  [key: string]: unknown;
};

export type LogSink = (level: LogLevel, line: string) => void;

const SECRET_KEY =
  /pass(word)?|secret|token|authorization|cookie|api[-_]?key|database_?url|connection_?string|credential|card_?number|cvv/i;
export const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redact(inner, depth + 1);
  }
  return out;
}

const defaultSink: LogSink = (level, line) => {
  if (level === "error" || level === "warn") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
};

export type Logger = {
  debug: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
  child: (context: LogContext) => Logger;
};

export function createLogger(context: LogContext = {}, sink: LogSink = defaultSink): Logger {
  const emit = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
    const entry = redact({ ...context, ...data }) as Record<string, unknown>;
    sink(level, JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...entry }));
  };
  return {
    debug: (message, data) => emit("debug", message, data),
    info: (message, data) => emit("info", message, data),
    warn: (message, data) => emit("warn", message, data),
    error: (message, data) => emit("error", message, data),
    child: (extra) => createLogger({ ...context, ...extra }, sink),
  };
}

export const logger = createLogger();
