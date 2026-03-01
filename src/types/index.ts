export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  service: string;
  environment?: string;
  version?: string;
  traceId?: string;
  spanId?: string;
  context?: Record<string, unknown>;
  error?: SerializedError;
  durationMs?: number;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
}

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
}

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface Span {
  context: SpanContext;
  name: string;
  startTime: bigint;
  endTime?: bigint;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  end(status?: SpanStatus, attributes?: Record<string, unknown>): void;
  setAttribute(key: string, value: unknown): void;
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  recordError(error: Error): void;
}

export interface SpanEvent {
  name: string;
  timestamp: string;
  attributes?: Record<string, unknown>;
}

export interface FinishedSpan
  extends Omit<Span, 'end' | 'setAttribute' | 'addEvent' | 'recordError'> {
  endTime: bigint;
  durationMs: number;
}

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface AlertRule {
  id: string;
  name: string;
  condition: AlertCondition;
  severity: AlertSeverity;
  channels: string[];
  cooldownMs: number;
  enabled: boolean;
}

export interface AlertCondition {
  type: 'log_level' | 'error_rate' | 'latency' | 'custom';
  level?: LogLevel;
  threshold?: number;
  latencyMs?: number;
  predicateKey?: string;
}

export interface Alert {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  message: string;
  triggeredAt: string;
  context?: Record<string, unknown>;
}

export interface Transport {
  id: string;
  send(entry: LogEntry): Promise<void>;
  sendAlert(alert: Alert): Promise<void>;
  flush?(): Promise<void>;
}

export interface ObserveConfig {
  service: string;
  environment?: string;
  version?: string;

  logging?: {
    level?: LogLevel;
    transports?: Transport[];
    bufferSize?: number;
    pretty?: boolean;
    redact?: string[];
    redactPaths?: string[];
    redactMaxDepth?: number;
    console?: boolean;
  };

  tracing?: {
    enabled?: boolean;
    sampleRate?: number;
    exporters?: SpanExporter[];
    maxQueueSize?: number;
    exportBatchSize?: number;
    flushIntervalMs?: number;
  };

  alerting?: {
    rules?: AlertRule[];
    transports?: Record<string, Transport>;
    predicates?: Record<string, (entry: LogEntry) => boolean>;
  };

  metrics?: {
    enabled?: boolean;
    intervalMs?: number; // How often to flush/log metrics
    logLevel?: LogLevel; // Level to log metrics at (default: info)
    system?: boolean; // Enable system metrics (CPU/Memory)
  };

  dashboard?: {
    enabled: boolean;
    port?: number;
    host?: string;
    storage?: MetricsStorage; // Custom storage provider
    auth?: {
      type: 'basic' | 'jwt';
      user?: string; // For Basic
      pass?: string; // For Basic
      jwtSecret?: string; // For JWT
    };
  };
}

export interface MetricsStorage {
  saveMetric(metric: MetricValue): void | Promise<void>;
  saveLog(log: LogEntry): void | Promise<void>;
  getMetrics(limit: number): Promise<MetricValue[]>;
  getLogs(limit: number): Promise<LogEntry[]>;
}

export interface SpanExporter {
  export(spans: FinishedSpan[]): Promise<void>;
}

// Metrics Types
export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricValue {
  name: string;
  type: MetricType;
  value: number;
  tags?: Record<string, string>;
  timestamp: string;
}
