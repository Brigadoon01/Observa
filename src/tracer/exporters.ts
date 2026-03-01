import type { SpanExporter, FinishedSpan } from '../types';

export class ConsoleSpanExporter implements SpanExporter {
  async export(spans: FinishedSpan[]): Promise<void> {
    for (const span of spans) {
      console.log(
        `\x1b[36m[TRACE]\x1b[0m ${span.name} | ${span.durationMs.toFixed(2)}ms | ` +
          `status=${span.status} | traceId=${span.context.traceId} | spanId=${span.context.spanId}` +
          (span.context.parentSpanId ? ` | parent=${span.context.parentSpanId}` : '')
      );
      if (Object.keys(span.attributes).length) {
        console.log('  attributes:', span.attributes);
      }
      if (span.events.length) {
        console.log('  events:', span.events);
      }
    }
  }
}

export interface HttpSpanExporterOptions {
  url: string;
  headers?: Record<string, string>;
}

export class HttpSpanExporter implements SpanExporter {
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(options: HttpSpanExporterOptions) {
    this.url = options.url;
    this.headers = { 'Content-Type': 'application/json', ...options.headers };
  }

  async export(spans: FinishedSpan[]): Promise<void> {
    await fetch(this.url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        resourceSpans: spans.map((s) => ({
          traceId: s.context.traceId,
          spanId: s.context.spanId,
          parentSpanId: s.context.parentSpanId,
          name: s.name,
          startTimeUnixNano: String(s.startTime),
          endTimeUnixNano: String(s.endTime),
          durationMs: s.durationMs,
          status: s.status,
          attributes: s.attributes,
          events: s.events,
        })),
      }),
    });
  }
}
