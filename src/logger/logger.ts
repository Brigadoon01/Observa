import type {
  LogLevel,
  LogEntry,
  Transport,
  ObserveConfig,
  SerializedError,
} from '../types';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

function serializeError(err: Error): SerializedError {
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    code: (err as NodeJS.ErrnoException).code,
  };
}

const REDACTED_VALUE = '[REDACTED]';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

function redactContext(
  obj: Record<string, unknown>,
  keys: string[],
  paths: string[],
  maxDepth: number
): Record<string, unknown> {
  if (!keys.length && !paths.length) return obj;

  const redactKeys = new Set(keys);
  const parsedPaths = paths
    .map((p) => p.split('.').filter(Boolean))
    .filter((p) => p.length > 0);

  const hasPathPrefix = (candidate: string[]): boolean =>
    parsedPaths.some((path) =>
      candidate.length <= path.length &&
      candidate.every((part, idx) => part === path[idx])
    );

  const isExactPath = (candidate: string[]): boolean =>
    parsedPaths.some(
      (path) =>
        candidate.length === path.length &&
        candidate.every((part, idx) => part === path[idx])
    );

  const visit = (value: unknown, path: string[], depth: number): unknown => {
    if (isExactPath(path)) return REDACTED_VALUE;
    if (depth >= maxDepth) return value;

    if (Array.isArray(value)) {
      if (!hasPathPrefix(path)) return value;
      return value.map((item, index) => visit(item, [...path, String(index)], depth + 1));
    }

    if (isPlainObject(value)) {
      if (!hasPathPrefix(path) && path.length > 0) return value;
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        const nextPath = [...path, key];
        if (path.length === 0 && redactKeys.has(key)) {
          output[key] = REDACTED_VALUE;
          continue;
        }
        output[key] = visit(child, nextPath, depth + 1);
      }
      return output;
    }

    return value;
  };

  return visit(obj, [], 0) as Record<string, unknown>;
}

export class Logger {
  private readonly service: string;
  private readonly environment?: string;
  private readonly version?: string;
  private readonly minLevel: number;
  private readonly transports: Transport[];
  private readonly redactKeys: string[];
  private readonly redactPaths: string[];
  private readonly redactMaxDepth: number;
  private readonly pretty: boolean;
  private readonly consoleEnabled: boolean;
  private readonly buffer: LogEntry[] = [];
  private readonly bufferSize: number;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly boundContext: Record<string, unknown>;
  private readonly onEntry?: (entry: LogEntry) => void | Promise<void>;
  private onLog?: (entry: LogEntry) => void;

  constructor(
    config: ObserveConfig,
    boundContext: Record<string, unknown> = {},
    onEntry?: (entry: LogEntry) => void | Promise<void>
  ) {
    this.service = config.service;
    this.environment = config.environment;
    this.version = config.version;
    this.minLevel = LOG_LEVELS[config.logging?.level ?? 'info'];
    this.transports = config.logging?.transports ?? [];
    this.redactKeys = config.logging?.redact ?? [];
    this.redactPaths = config.logging?.redactPaths ?? [];
    this.redactMaxDepth = config.logging?.redactMaxDepth ?? 6;
    this.bufferSize = config.logging?.bufferSize ?? 100;
    this.pretty = config.logging?.pretty ?? process.env.NODE_ENV === 'development';
    this.consoleEnabled = config.logging?.console ?? true;
    this.boundContext = boundContext;
    this.onEntry = onEntry;
  }

  getService(): string {
    return this.service;
  }

  setOnLog(callback: (entry: LogEntry) => void) {
    this.onLog = callback;
  }

  getEnvironment(): string | undefined {
    return this.environment;
  }

  getVersion(): string | undefined {
    return this.version;
  }

  child(context: Record<string, unknown>): Logger {
    const merged = { ...this.boundContext, ...context };
    return new Logger(
      {
        service: this.service,
        environment: this.environment,
        version: this.version,
        logging: {
          level: Object.keys(LOG_LEVELS).find(
            (k) => LOG_LEVELS[k as LogLevel] === this.minLevel
          ) as LogLevel,
          transports: this.transports,
          redact: this.redactKeys,
          redactPaths: this.redactPaths,
          redactMaxDepth: this.redactMaxDepth,
          bufferSize: this.bufferSize,
          pretty: this.pretty,
          console: this.consoleEnabled,
        },
      },
      merged,
      this.onEntry
    );
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.log('error', message, context, error);
  }

  fatal(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.log('fatal', message, context, error);
    void this.flush();
  }

  withTrace(traceId: string, spanId: string): Logger {
    return this.child({ traceId, spanId });
  }

  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    error?: Error
  ): void {
    if (LOG_LEVELS[level] < this.minLevel) return;

    const mergedContext = {
      ...this.boundContext,
      ...(context ?? {}),
    };

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service: this.service,
      environment: this.environment,
      version: this.version,
      context: Object.keys(mergedContext).length
        ? redactContext(
            mergedContext,
            this.redactKeys,
            this.redactPaths,
            this.redactMaxDepth
          )
        : undefined,
      error: error ? serializeError(error) : undefined,
    };

    if (typeof mergedContext.durationMs === 'number') {
      entry.durationMs = mergedContext.durationMs;
    }

    if (mergedContext.traceId) entry.traceId = mergedContext.traceId as string;
    if (mergedContext.spanId) entry.spanId = mergedContext.spanId as string;

    this.write(entry);
  }

  private write(entry: LogEntry): void {
    this.writeToConsole(entry);

    if (this.transports.length > 0) {
      this.buffer.push(entry);
      if (this.buffer.length >= this.bufferSize) {
        void this.flush();
      } else {
        this.scheduleFlush();
      }
    }

    if (this.onEntry) {
      void Promise.resolve(this.onEntry(entry)).catch(() => undefined);
    }

    if (this.onLog) {
      // Create a clean copy without circular references or large objects if needed
      // For now, passing entry is fine as it's already structured
      try {
        // Deep clone to avoid mutation issues if the callback modifies it
        // and to ensure it's serializable
        const cleanEntry = JSON.parse(JSON.stringify(entry));
        this.onLog(cleanEntry);
      } catch (e) {
        // ignore serialization errors
      }
    }
  }

  private writeToConsole(entry: LogEntry): void {
    if (!this.consoleEnabled) return;
    if (this.pretty) {
      const color = LEVEL_COLORS[entry.level];
      const reset = '\x1b[0m';
      console.log(
        `${color}[${entry.level.toUpperCase()}]${reset} ${entry.timestamp} ${entry.service} — ${entry.message}`,
        entry.context ? entry.context : '',
        entry.error ? entry.error : ''
      );
    } else {
      const line = JSON.stringify(entry);
      if (entry.level === 'error' || entry.level === 'fatal') {
        process.stderr.write(line + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      void this.flush();
    }, 200);
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const batch = this.buffer.splice(0, this.buffer.length);

    if (batch.length) {
      await Promise.allSettled(
        this.transports.flatMap((t) => batch.map((entry) => t.send(entry)))
      );
    }

    const flushers = this.transports
      .map((t) => t.flush?.())
      .filter((p): p is Promise<void> => Boolean(p));

    if (flushers.length) {
      await Promise.allSettled(flushers);
    }
  }
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[37m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[35m',
};
