import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';
import type {
  Span,
  SpanContext,
  SpanStatus,
  FinishedSpan,
  SpanEvent,
  SpanExporter,
  ObserveConfig,
} from '../types';

function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

function hrtimeToMs(start: bigint, end: bigint): number {
  return Number(end - start) / 1_000_000;
}

class SpanImpl implements Span {
  context: SpanContext;
  name: string;
  startTime: bigint;
  endTime?: bigint;
  status: SpanStatus = 'unset';
  attributes: Record<string, unknown> = {};
  events: SpanEvent[] = [];

  private readonly onEnd: (span: FinishedSpan) => void;

  constructor(
    name: string,
    context: SpanContext,
    attributes: Record<string, unknown>,
    onEnd: (span: FinishedSpan) => void
  ) {
    this.name = name;
    this.context = context;
    this.startTime = process.hrtime.bigint();
    this.attributes = attributes;
    this.onEnd = onEnd;
  }

  setAttribute(key: string, value: unknown): void {
    this.attributes[key] = value;
  }

  addEvent(name: string, attributes?: Record<string, unknown>): void {
    this.events.push({
      name,
      timestamp: new Date().toISOString(),
      attributes,
    });
  }

  recordError(error: Error): void {
    this.status = 'error';
    this.addEvent('error', {
      'error.type': error.name,
      'error.message': error.message,
      'error.stack': error.stack,
    });
  }

  end(status?: SpanStatus, attributes?: Record<string, unknown>): void {
    if (this.endTime) return;

    this.endTime = process.hrtime.bigint();
    if (status) this.status = status;
    if (attributes) Object.assign(this.attributes, attributes);

    const finished: FinishedSpan = {
      ...this,
      endTime: this.endTime,
      durationMs: hrtimeToMs(this.startTime, this.endTime),
    };

    this.onEnd(finished);
  }
}

export class Tracer {
  private readonly storage = new AsyncLocalStorage<SpanContext>();
  private readonly sampleRate: number;
  private readonly exporters: SpanExporter[];
  private readonly exportQueue: FinishedSpan[] = [];
  private readonly enabled: boolean;
  private readonly maxQueueSize: number;
  private readonly exportBatchSize: number;
  private readonly flushIntervalMs: number;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(config: ObserveConfig) {
    this.enabled = config.tracing?.enabled ?? true;
    this.sampleRate = this.enabled ? (config.tracing?.sampleRate ?? 1) : 0;
    this.exporters = config.tracing?.exporters ?? [];
    this.maxQueueSize = config.tracing?.maxQueueSize ?? 2000;
    this.exportBatchSize = config.tracing?.exportBatchSize ?? 50;
    this.flushIntervalMs = config.tracing?.flushIntervalMs ?? 500;
  }

  async startSpan<T>(
    name: string,
    attributes: Record<string, unknown> = {},
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    const parent = this.storage.getStore();
    const sampled = parent?.sampled ?? Math.random() < this.sampleRate;

    const context: SpanContext = {
      traceId: parent?.traceId ?? generateTraceId(),
      spanId: generateSpanId(),
      parentSpanId: parent?.spanId,
      sampled: this.enabled ? sampled : false,
    };

    const span = new SpanImpl(name, context, attributes, (finished) => {
      this.onSpanEnd(finished);
    });

    try {
      const result = await this.storage.run(context, () => fn(span));
      if (span.status === 'unset') span.end('ok');
      return result;
    } catch (err) {
      span.recordError(err as Error);
      span.end('error');
      throw err;
    }
  }

  getActiveContext(): SpanContext | undefined {
    return this.storage.getStore();
  }

  extractContext(traceparent: string): SpanContext | null {
    const parts = traceparent.trim().split('-');
    if (parts.length !== 4 || parts[0] !== '00') return null;

    const [, traceId, spanId, flags] = parts;
    if (!/^[0-9a-f]{32}$/i.test(traceId)) return null;
    if (!/^[0-9a-f]{16}$/i.test(spanId)) return null;
    if (!/^[0-9a-f]{2}$/i.test(flags)) return null;
    if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
    if (flags.length !== 2) return null;
    const sampled = (parseInt(flags, 16) & 1) === 1;

    return {
      traceId,
      spanId,
      sampled,
    };
  }

  injectContext(): string | null {
    const ctx = this.storage.getStore();
    if (!ctx) return null;
    const flags = ctx.sampled ? '01' : '00';
    return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
  }

  createRootContext(sampled?: boolean): SpanContext {
    const decision = sampled ?? Math.random() < this.sampleRate;
    return {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      sampled: this.enabled ? decision : false,
    };
  }

  runWithContext<T>(context: SpanContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  private onSpanEnd(span: FinishedSpan): void {
    if (!span.context.sampled || !this.exporters.length) return;

    if (this.exportQueue.length >= this.maxQueueSize) {
      this.exportQueue.shift();
    }
    this.exportQueue.push(span);

    if (this.exportQueue.length >= this.exportBatchSize) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => void this.flush(), this.flushIntervalMs);
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.exportQueue.length) return;

    const batch = this.exportQueue.splice(0, this.exportBatchSize);
    await Promise.allSettled(this.exporters.map((e) => e.export(batch)));
    if (this.exportQueue.length) {
      this.scheduleFlush();
    }
  }
}
