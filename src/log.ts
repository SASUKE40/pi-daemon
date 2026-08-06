const SECRET_KEYS = /(?:token|authorization|api[-_]?key|secret|cookie)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.test(key) ? "[REDACTED]" : redact(item)]));
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]");
  }
  return value;
}

function write(level: "info" | "warn" | "error", message: string, details?: unknown): void {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(details === undefined ? {} : { details: redact(details) }),
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

export const log = {
  info: (message: string, details?: unknown) => write("info", message, details),
  warn: (message: string, details?: unknown) => write("warn", message, details),
  error: (message: string, details?: unknown) => write("error", message, details),
};
