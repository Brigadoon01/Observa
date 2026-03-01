// ============================================================
// Example — Full Express app using NodeObserve
// Shows: SDK init, middleware, route-level tracing, alerting
// ============================================================

import express from 'express';
import {
  ObserveSDK,
  SlackTransport,
  FileTransport,
  HttpTransport,
  ConsoleSpanExporter,
} from './src/index'; // in your project: from '@emperorwilliams/nodeobserve'

// ---- 1. Initialize SDK ----------------------------------------

const observe = ObserveSDK.init({
  service: 'payment-service',
  environment: process.env.NODE_ENV ?? 'development',
  version: process.env.APP_VERSION ?? '1.0.0',

  logging: {
    level: 'info',
    pretty: process.env.NODE_ENV !== 'production',
    redact: ['password', 'cardNumber', 'cvv', 'authorization'],
    transports: [
      new FileTransport({
        id: 'file',
        filePath: './logs/app.log',
        alertFilePath: './logs/alerts.log',
      }),
      new HttpTransport({
        id: 'datadog',
        url: `https://http-intake.logs.datadoghq.com/v1/input/${process.env.DD_API_KEY}`,
        headers: { 'DD-API-KEY': process.env.DD_API_KEY ?? '' },
        batchSize: 50,
      }),
    ],
  },

  tracing: {
    sampleRate: 0.2, // 20% sampling in production
    exporters: [
      new ConsoleSpanExporter(), // dev only
      // new HttpSpanExporter({ url: 'http://jaeger:14268/api/traces' }),
    ],
  },

  alerting: {
    rules: [
      {
        id: 'fatal-errors',
        name: 'Fatal Error Alert',
        condition: { type: 'log_level', level: 'fatal' },
        severity: 'critical',
        channels: ['slack', 'pagerduty'],
        cooldownMs: 2 * 60_000, // 2 minutes
        enabled: true,
      },
      {
        id: 'error-rate-high',
        name: 'High Error Rate',
        condition: { type: 'error_rate', threshold: 10 }, // 10 errors/min
        severity: 'high',
        channels: ['slack'],
        cooldownMs: 5 * 60_000,
        enabled: true,
      },
      {
        id: 'slow-endpoints',
        name: 'Slow API Response',
        condition: { type: 'latency', latencyMs: 5000 },
        severity: 'medium',
        channels: ['slack'],
        cooldownMs: 60_000,
        enabled: true,
      },
      {
        id: 'payment-failures',
        name: 'Payment Processing Error',
        condition: { type: 'custom', predicateKey: 'isPaymentError' },
        severity: 'critical',
        channels: ['slack', 'webhook'],
        cooldownMs: 0, // alert on every payment failure
        enabled: true,
      },
    ],
    transports: {
      slack: new SlackTransport({
        id: 'slack',
        webhookUrl: process.env.SLACK_WEBHOOK_URL ?? '',
        minSeverity: 'medium',
      }),
      // pagerduty: new PagerDutyTransport({ integrationKey: process.env.PD_KEY ?? '' }),
      // webhook: new WebhookTransport({ url: process.env.OPS_WEBHOOK_URL ?? '' }),
    },
    predicates: {
      isPaymentError: (entry) =>
        entry.context?.domain === 'payments' &&
        ['error', 'fatal'].includes(entry.level),
    },
  },
});

// ---- 2. Application setup ------------------------------------

const app = express();
app.use(express.json());

// Mount observability middleware — must be before routes
app.use(
  observe.middleware({
    ignorePaths: ['/health', '/metrics'],
    logBody: false,
  })
);

// ---- 3. Routes (showing logger + tracer usage) ---------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/v1/payments', async (req, res) => {
  // Access the request-scoped child logger (has traceId, requestId bound)
  const log = res.locals.logger;

  try {
    const { amount, currency, userId } = req.body;

    // Trace a database call
    const order = await observe.tracer.startSpan(
      'db.create_order',
      { 'db.table': 'orders', 'db.operation': 'insert' },
      async (span) => {
        // Simulate DB latency
        await new Promise((r) => setTimeout(r, 50));
        span.setAttribute('order.amount', amount);
        return { id: 'order-123', amount, currency };
      }
    );

    // Trace payment gateway call
    const payment = await observe.tracer.startSpan(
      'external.payment_gateway',
      { 'http.url': 'https://stripe.com/v1/charges', 'http.method': 'POST' },
      async (span) => {
        await new Promise((r) => setTimeout(r, 120));
        span.setAttribute('payment.gateway', 'stripe');
        return { chargeId: 'ch_xyz', status: 'succeeded' };
      }
    );

    log.info('payment.processed', {
      domain: 'payments',
      orderId: order.id,
      chargeId: payment.chargeId,
      amount,
      currency,
      userId,
    });

    res.status(201).json({ success: true, orderId: order.id, chargeId: payment.chargeId });
  } catch (err) {
    log.error('payment.failed', err as Error, {
      domain: 'payments',
      userId: req.body.userId,
    });

    // This will trigger the payment-failures alert rule
    res.status(500).json({ success: false, error: 'Payment processing failed' });
  }
});

// ---- 4. Manually trigger alerts from application code --------

// Example: business event alert (not tied to log level)
// observe.alertEngine.trigger(
//   { id: 'fraud-detected', name: 'Fraud Alert', severity: 'critical', channels: ['slack'] },
//   'Suspicious transaction pattern detected',
//   { userId: 'u-999', amount: 50000 }
// );

// ---- 5. Start server -----------------------------------------

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  observe.logger.info('server.started', { port: PORT });
});
