# NodeObserve

Production-grade observability SDK for Node.js. Structured logging, distributed tracing, multi-channel alerting, and metrics — all from one init call.

---

## Installation

```bash
npm install @emperorwilliams/nodeobserve
```

Node 18+ required.

---

## Quick Start

```typescript
import { ObserveSDK, SlackTransport, FileTransport, ConsoleSpanExporter } from '@emperorwilliams/nodeobserve';

const observe = ObserveSDK.init({
  service: 'my-service',
  environment: 'production',

  logging: {
    level: 'info',
    redact: ['password', 'token', 'cardNumber'],
    transports: [new FileTransport({ filePath: './logs/app.log' })],
  },

  tracing: {
    sampleRate: 0.1, // 10%
    exporters: [new ConsoleSpanExporter()],
  },

  metrics: {
    enabled: true,
    system: true, // Auto-collect CPU/Memory
    intervalMs: 60_000,
  },

  alerting: {
    rules: [{
      id: 'errors',
      name: 'Error Alert',
      condition: { type: 'log_level', level: 'error' },
      severity: 'high',
      channels: ['slack'],
      cooldownMs: 300_000,
      enabled: true,
    }],
    transports: {
      slack: new SlackTransport({ webhookUrl: process.env.SLACK_WEBHOOK_URL! }),
    },
  },
});

// Express
app.use(observe.middleware({ ignorePaths: ['/health'] }));
```

---

## Metrics API

NodeObserve supports the "Three Pillars of Observability" by including a built-in Metrics engine. Metrics are flushed periodically as structured logs with `message: 'metrics.flush'`.

### Configuration

```typescript
metrics: {
  enabled: true,
  intervalMs: 10000, // Flush every 10s
  logLevel: 'info',  // Level to log metrics at (debug, info, etc.)
  system: true       // Collect process.memory and system.load
}
```

### Usage

```typescript
// Counter (Incrementing values)
const requests = observe.metrics.counter('http.requests', { route: '/api' });
requests.inc();

// Gauge (Point-in-time values)
const activeUsers = observe.metrics.gauge('users.active');
activeUsers.set(42);

// Histogram (Distribution/Percentiles)
const latency = observe.metrics.histogram('http.latency');
latency.record(150);
```

### System Metrics (Auto-collected)
- `process.memory.rss`
- `process.memory.heap_used`
- `process.memory.heap_total`
- `system.load.1m`, `5m`, `15m`
- `process.uptime`

---

## Custom Transports (Connect to Any Platform)

You can connect NodeObserve to any logging or alerting backend (Datadog, Splunk, Loki, etc.) by implementing the `Transport` interface.

### 1. Implement the Transport

```typescript
import { Transport, LogEntry, Alert } from '@emperorwilliams/nodeobserve';

export class MyCustomTransport implements Transport {
  readonly id = 'my-custom-platform';

  async send(entry: LogEntry): Promise<void> {
    // Send logs to your backend
    await fetch('https://api.custom-platform.com/logs', {
      method: 'POST',
      body: JSON.stringify(entry)
    });
  }

  async sendAlert(alert: Alert): Promise<void> {
    // Send alerts to your backend
    await fetch('https://api.custom-platform.com/alerts', {
      method: 'POST',
      body: JSON.stringify(alert)
    });
  }
}
```

### 2. Register it

```typescript
const observe = ObserveSDK.init({
  // ...
  logging: {
    transports: [new MyCustomTransport()]
  },
  alerting: {
    transports: {
      'custom': new MyCustomTransport()
    },
    rules: [
      {
        id: 'rule-1',
        channels: ['custom'], // Use the key you defined in transports
        // ...
      }
    ]
  }
});
```

See `example-custom-transport.ts` for a complete runnable example.

---

## Architecture

```
ObserveSDK
├── Logger               — Structured JSON, leveled, buffered, redaction-aware
│   └── Transports       — Console | File | HTTP | Slack | Webhook | PagerDuty
├── Tracer               — W3C traceparent, AsyncLocalStorage propagation
│   └── Exporters        — Console | HTTP (OTLP-lite, Jaeger-compatible)
├── Metrics              — Counters | Gauges | Histograms | System Monitor
├── AlertEngine          — Rule evaluation, sliding windows, cooldowns, fanout
└── Middleware (Express) — Auto trace/log injection per request
```

### Key Design Decisions

**Logger** uses `AsyncLocalStorage` indirectly via child loggers — call `logger.child({ requestId })` once in middleware and every downstream call in the request lifecycle automatically carries the context. Logs below `minLevel` are discarded before any serialization occurs (zero-cost filtering). Transport writes are async-buffered with a 200ms debounce, except `fatal` which flushes immediately.

**Tracer** uses `AsyncLocalStorage` natively — spans propagate automatically to nested async calls with no manual context passing. Fully W3C `traceparent` compatible: extract from incoming HTTP headers, inject into outgoing. Sampling is decided once per root span and inherited by all children. Finished spans are batched and exported async.

**Metrics** aggregates values in-memory and flushes them periodically as a special log entry (`metrics.flush`). This allows you to use your existing log aggregation pipeline (e.g., Datadog Logs, Loki) to extract metrics without setting up a separate metrics pipeline.

**AlertEngine** evaluates rules against every log entry (post-write). Three built-in condition types:
- `log_level` — fires when entry level ≥ threshold
- `error_rate` — sliding 60s window, fires when error count ≥ threshold
- `latency` — fires when `entry.durationMs` ≥ threshold
- `custom` — your own predicate function

Per-rule cooldowns prevent alert storms. Multi-channel fanout is `Promise.allSettled` (one failing transport never blocks others).

---

## Logger API

```typescript
// Top-level
observe.logger.info('message', { key: 'value' });
observe.logger.error('failed', new Error('reason'), { context: 'data' });
observe.logger.fatal('critical failure', err); // flushes immediately

// Child logger (inherits + merges context)
const log = observe.logger.child({ requestId, userId });
log.info('user action'); // logs { requestId, userId, ...message }

// Bind trace context manually
const tracedLog = observe.logger.withTrace(traceId, spanId);
```

### Log Levels (ascending)
`debug` → `info` → `warn` → `error` → `fatal`

---

## Tracer API

```typescript
// Wrap any async operation
const result = await observe.tracer.startSpan('operation.name', { attr: 'val' }, async (span) => {
  span.setAttribute('dynamic.attr', someValue);
  span.addEvent('cache.miss');
  return await doWork();
  // span auto-ends ok on return, error on throw
});

// Get active trace context (for manual log injection)
const ctx = observe.tracer.getActiveContext();
// → { traceId, spanId, sampled }

// Distributed tracing — incoming HTTP
const ctx = tracer.extractContext(req.headers['traceparent']);

// Outgoing HTTP
const headers = { traceparent: tracer.injectContext() };
```

---

## Alert Rules

```typescript
// log_level — fires when any log at this level or above is written
{ type: 'log_level', level: 'error' }

// error_rate — fires when N errors occur within 60 seconds
{ type: 'error_rate', threshold: 10 }

// latency — fires when a log entry carries durationMs ≥ threshold
{ type: 'latency', latencyMs: 3000 }

// custom — your own predicate
{ type: 'custom', predicateKey: 'myPredicate' }
// + register: alerting.predicates: { myPredicate: (entry) => boolean }
```

### Manual Alert Trigger

```typescript
await observe.alertEngine.trigger(
  { id: 'fraud', name: 'Fraud Detected', severity: 'critical', channels: ['slack'] },
  'Unusual transaction pattern',
  { userId: 'u-999' }
);
```

---

## Transports

| Transport | Logs | Alerts | Notes |
|-----------|------|--------|-------|
| `ConsoleTransport` | via Logger | ✅ | Dev use |
| `FileTransport` | ✅ | ✅ | JSONL format |
| `HttpTransport` | ✅ batched | ✅ immediate | Datadog, custom |
| `SlackTransport` | ❌ | ✅ | Block Kit formatting |
| `WebhookTransport` | optional | ✅ | Generic POST |
| `PagerDutyTransport` | ❌ | ✅ | Events API v2 |

---

## Production Checklist

- [ ] Set `logging.level` to `info` (not `debug`)
- [ ] Set `tracing.sampleRate` to 0.1–0.2 (not 1.0)
- [ ] Configure `redact` with all PII field names
- [ ] Set meaningful `cooldownMs` on alert rules (prevent storms)
- [ ] Use `HttpTransport` to ship logs to your aggregator (Datadog, Loki, etc.)
- [ ] Ship spans to Jaeger/Tempo with `HttpSpanExporter`
- [ ] Ensure `SIGTERM` handler is in place (SDK registers it automatically)

---

## Folder Structure

```
src/
├── types/index.ts          — All shared interfaces (single source of truth)
├── logger/logger.ts        — Logger implementation
├── tracer/
│   ├── tracer.ts           — Span management + AsyncLocalStorage
│   └── exporters.ts        — Console + HTTP span exporters
├── alerting/
│   └── alert-engine.ts     — Rule engine + fanout
├── metrics/
│   ├── metrics-engine.ts   — Metric collection & aggregation
│   └── system-monitor.ts   — Automatic CPU/Mem tracking
├── transports/index.ts     — All transport implementations
├── middleware/express.ts   — Express integration
└── index.ts                — SDK entry point + re-exports
```
