// ============================================================
// Tests — Logger, Tracer, AlertEngine
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from './src/logger/logger';
import { Tracer } from './src/tracer/tracer';
import { AlertEngine } from './src/alerting/alert-engine';
import type { ObserveConfig, Transport, LogEntry, Alert } from './src/types';

// ---- Mock Transport -------------------------------------------

function createMockTransport(id = 'mock'): Transport & {
  logs: LogEntry[];
  alerts: Alert[];
} {
  const logs: LogEntry[] = [];
  const alerts: Alert[] = [];
  return {
    id,
    logs,
    alerts,
    async send(entry) { logs.push(entry); },
    async sendAlert(alert) { alerts.push(alert); },
  };
}

// ---- Logger Tests --------------------------------------------

describe('Logger', () => {
  it('filters out logs below minLevel', async () => {
    const transport = createMockTransport();
    const config: ObserveConfig = {
      service: 'test-svc',
      logging: { level: 'warn', transports: [transport] },
    };
    const logger = new Logger(config);

    logger.debug('should be filtered');
    logger.info('should be filtered');
    logger.warn('should pass');
    logger.error('should pass');

    await logger.flush();
    expect(transport.logs).toHaveLength(2);
    expect(transport.logs[0].level).toBe('warn');
    expect(transport.logs[1].level).toBe('error');
  });

  it('redacts sensitive keys from context', async () => {
    const transport = createMockTransport();
    const config: ObserveConfig = {
      service: 'test-svc',
      logging: {
        level: 'debug',
        transports: [transport],
        redact: ['password', 'token'],
        redactPaths: ['user.profile.ssn', 'payment.card.number'],
      },
    };
    const logger = new Logger(config);

    logger.info('user login', {
      userId: 'u1',
      password: 'secret123',
      token: 'abc',
      user: { profile: { ssn: '111-22-3333' } },
      payment: { card: { number: '4242424242424242' } },
    });
    await logger.flush();

    const entry = transport.logs[0];
    expect(entry.context?.password).toBe('[REDACTED]');
    expect(entry.context?.token).toBe('[REDACTED]');
    expect(entry.context?.userId).toBe('u1');
    expect((entry.context as any).user.profile.ssn).toBe('[REDACTED]');
    expect((entry.context as any).payment.card.number).toBe('[REDACTED]');
  });

  it('child logger inherits and merges context', async () => {
    const transport = createMockTransport();
    const config: ObserveConfig = {
      service: 'test-svc',
      logging: { level: 'debug', transports: [transport] },
    };
    const logger = new Logger(config);
    const child = logger.child({ requestId: 'req-1' });
    const grandchild = child.child({ userId: 'u-42' });

    grandchild.info('deep log');
    await grandchild.flush();

    const entry = transport.logs[0];
    expect(entry.context?.requestId).toBe('req-1');
    expect(entry.context?.userId).toBe('u-42');
  });

  it('serializes errors correctly', async () => {
    const transport = createMockTransport();
    const config: ObserveConfig = {
      service: 'test-svc',
      logging: { level: 'debug', transports: [transport] },
    };
    const logger = new Logger(config);
    const err = new Error('db connection failed');

    logger.error('database error', err);
    await logger.flush();

    const entry = transport.logs[0];
    expect(entry.error?.name).toBe('Error');
    expect(entry.error?.message).toBe('db connection failed');
    expect(entry.error?.stack).toBeDefined();
  });
});

// ---- Tracer Tests --------------------------------------------

describe('Tracer', () => {
  it('generates a valid W3C trace context', async () => {
    const config: ObserveConfig = { service: 'test-svc', tracing: { enabled: true } };
    const tracer = new Tracer(config);

    await tracer.startSpan('test.op', {}, async (span) => {
      expect(span.context.traceId).toHaveLength(32);
      expect(span.context.spanId).toHaveLength(16);
      expect(span.context.sampled).toBe(true);
    });
  });

  it('propagates parent span context to child spans', async () => {
    const config: ObserveConfig = { service: 'test-svc', tracing: { enabled: true } };
    const tracer = new Tracer(config);
    let childParentId: string | undefined;
    let parentSpanId: string | undefined;

    await tracer.startSpan('parent', {}, async (parent) => {
      parentSpanId = parent.context.spanId;
      await tracer.startSpan('child', {}, async (child) => {
        childParentId = child.context.parentSpanId;
        expect(child.context.traceId).toBe(parent.context.traceId);
      });
    });

    expect(childParentId).toBe(parentSpanId);
  });

  it('marks span as error on thrown exception', async () => {
    const exported: import('./src/types').FinishedSpan[] = [];
    const config: ObserveConfig = {
      service: 'test-svc',
      tracing: {
        enabled: true,
        exporters: [{ async export(spans) { exported.push(...spans); } }],
      },
    };
    const tracer = new Tracer(config);

    await expect(
      tracer.startSpan('failing.op', {}, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    await tracer.flush();
    expect(exported[0].status).toBe('error');
    expect(exported[0].events.some((e) => e.name === 'error')).toBe(true);
  });

  it('parses and injects W3C traceparent headers', async () => {
    const config: ObserveConfig = { service: 'test-svc', tracing: { enabled: true } };
    const tracer = new Tracer(config);
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    const ctx = tracer.extractContext(header);
    expect(ctx?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(ctx?.spanId).toBe('00f067aa0ba902b7');
    expect(ctx?.sampled).toBe(true);
  });

  it('rejects invalid traceparent headers', async () => {
    const config: ObserveConfig = { service: 'test-svc', tracing: { enabled: true } };
    const tracer = new Tracer(config);
    expect(tracer.extractContext('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
    expect(tracer.extractContext('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBeNull();
    expect(tracer.extractContext('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-zz')).toBeNull();
    expect(tracer.extractContext('invalid')).toBeNull();
  });

  it('respects sample rate', async () => {
    const exported: import('./src/types').FinishedSpan[] = [];
    const config: ObserveConfig = {
      service: 'test-svc',
      tracing: {
        sampleRate: 0, // sample nothing
        exporters: [{ async export(spans) { exported.push(...spans); } }],
      },
    };
    const tracer = new Tracer(config);

    for (let i = 0; i < 10; i++) {
      await tracer.startSpan('op', {}, async () => {});
    }

    await tracer.flush();
    expect(exported).toHaveLength(0);
  });
});

// ---- AlertEngine Tests ---------------------------------------

describe('AlertEngine', () => {
  it('fires alert on log_level condition match', async () => {
    const transport = createMockTransport('slack');
    const config: ObserveConfig = {
      service: 'test-svc',
      alerting: {
        rules: [{
          id: 'rule-1',
          name: 'Error Alert',
          condition: { type: 'log_level', level: 'error' },
          severity: 'high',
          channels: ['slack'],
          cooldownMs: 0,
          enabled: true,
        }],
        transports: { slack: transport },
      },
    };
    const engine = new AlertEngine(config);

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'error',
      message: 'something broke',
      service: 'test-svc',
    };

    await engine.evaluate(entry);
    expect(transport.alerts).toHaveLength(1);
    expect(transport.alerts[0].severity).toBe('high');
    expect(transport.alerts[0].ruleId).toBe('rule-1');
  });

  it('respects cooldown — does not double-fire', async () => {
    const transport = createMockTransport('slack');
    const config: ObserveConfig = {
      service: 'test-svc',
      alerting: {
        rules: [{
          id: 'rule-1',
          name: 'Error Alert',
          condition: { type: 'log_level', level: 'error' },
          severity: 'high',
          channels: ['slack'],
          cooldownMs: 60_000, // 1 minute cooldown
          enabled: true,
        }],
        transports: { slack: transport },
      },
    };
    const engine = new AlertEngine(config);

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'error',
      message: 'boom',
      service: 'test-svc',
    };

    await engine.evaluate(entry);
    await engine.evaluate(entry); // should be suppressed by cooldown
    expect(transport.alerts).toHaveLength(1);
  });

  it('evaluates error_rate condition over sliding window', async () => {
    const transport = createMockTransport('slack');
    const config: ObserveConfig = {
      service: 'test-svc',
      alerting: {
        rules: [{
          id: 'rate-rule',
          name: 'Error Rate Alert',
          condition: { type: 'error_rate', threshold: 3 },
          severity: 'critical',
          channels: ['slack'],
          cooldownMs: 0,
          enabled: true,
        }],
        transports: { slack: transport },
      },
    };
    const engine = new AlertEngine(config);

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'error',
      message: 'error',
      service: 'test-svc',
    };

    // Fire 3 errors — threshold is 3, so 3rd should trigger
    await engine.evaluate(entry);
    await engine.evaluate(entry);
    expect(transport.alerts).toHaveLength(0); // not yet

    await engine.evaluate(entry);
    expect(transport.alerts).toHaveLength(1); // triggered
  });

  it('evaluates custom predicate condition', async () => {
    const transport = createMockTransport('webhook');
    const config: ObserveConfig = {
      service: 'test-svc',
      alerting: {
        rules: [{
          id: 'custom-rule',
          name: 'Payment Failure',
          condition: { type: 'custom', predicateKey: 'isPaymentError' },
          severity: 'critical',
          channels: ['webhook'],
          cooldownMs: 0,
          enabled: true,
        }],
        transports: { webhook: transport },
        predicates: {
          isPaymentError: (entry) =>
            entry.context?.domain === 'payments' && entry.level === 'error',
        },
      },
    };
    const engine = new AlertEngine(config);

    await engine.evaluate({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: 'charge failed',
      service: 'test-svc',
      context: { domain: 'payments' },
    });

    await engine.evaluate({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: 'not a payment',
      service: 'test-svc',
      context: { domain: 'auth' },
    });

    expect(transport.alerts).toHaveLength(1);
  });
});
