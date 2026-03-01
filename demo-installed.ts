
// ============================================================
// Real-World Demo: E-Commerce Payment Service
// Uses the installed package: @jeremiah01/observa
// ============================================================

import express from 'express';
import { 
  ObserveSDK, 
  ConsoleSpanExporter, 
  FileTransport,
  SlackTransport
} from '@jeremiah01/observa';

const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
const alertChannels = slackWebhookUrl ? ['console', 'slack'] : ['console'];

// 1. Initialize SDK
console.log('🚀 Initializing Observability SDK...');
const observe = ObserveSDK.init({
  service: 'payment-service',
  environment: 'production',
  
  // LOGGING: Structured JSON logs to console & file
  logging: {
    level: 'info',
    redact: ['cardNumber', 'cvv'], // Protect PII
    transports: [
      new FileTransport({ filePath: './payment-service.log' })
    ]
  },

  // TRACING: Trace requests through the system
  tracing: {
    sampleRate: 1.0, // Trace 100% for this demo
    exporters: [new ConsoleSpanExporter()]
  },

  // METRICS: Track business KPIs & System Health
  metrics: {
    enabled: true,
    intervalMs: 5000, // Flush metrics every 5s
    system: true      // CPU/Memory stats
  },

  // ALERTING: Detect anomalies
  alerting: {
    rules: [
      {
        id: 'high-value-payment',
        name: 'High Value Transaction',
        condition: { type: 'custom', predicateKey: 'isHighValue' },
        severity: 'medium',
        channels: ['console'], // Simple console alert for demo
        cooldownMs: 0,
        enabled: true
      },
      {
        id: 'payment-failure',
        name: 'Payment Failure Spike',
        condition: { type: 'log_level', level: 'error' },
        severity: 'critical',
        channels: alertChannels,
        cooldownMs: 0,
        enabled: true
      }
    ],
    predicates: {
      isHighValue: (entry) => (entry.context?.amount as number) > 1000
    },
    transports: {
      console: {
        id: 'console-alert',
        send: async () => {},
        sendAlert: async (alert) => {
          console.error(`\n🚨 [ALERT TRIGGERED] ${alert.ruleName}: ${alert.message}\n`);
        }
      },
      ...(slackWebhookUrl
        ? {
            slack: new SlackTransport({
              webhookUrl: slackWebhookUrl,
              minSeverity: 'high'
            })
          }
        : {})
    }
  }
});

// 2. Metrics Setup
const paymentCounter = observe.metrics.counter('payments.processed');
const paymentLatency = observe.metrics.histogram('payments.latency_ms');
const activeCarts = observe.metrics.gauge('carts.active');

// 3. Express App
const app = express();
app.use(express.json());
app.use(observe.middleware()); // Auto-instrumentation

// Simulated Database
const db = {
  processPayment: async (amount: number) => {
    return await observe.tracer.startSpan('db.charge_card', { amount }, async (span) => {
      // Simulate work
      const ms = Math.random() * 200;
      await new Promise(r => setTimeout(r, ms));
      
      if (Math.random() < 0.2) throw new Error('Insufficient Funds');
      
      span.setAttribute('payment.status', 'success');
      return { id: 'tx_' + Math.floor(Math.random() * 10000) };
    });
  }
};

// Route: Process Payment
app.post('/checkout', async (req, res) => {
  const { amount, cardNumber } = req.body;
  const start = Date.now();
  const log = res.locals.logger;

  // Track active carts (Gauge)
  activeCarts.set(Math.floor(Math.random() * 50) + 10);

  try {
    log.info('Processing payment', { amount, cardNumber, currency: 'USD' });

    const result = await db.processPayment(amount);
    
    // Metrics: Success
    paymentCounter.inc();
    paymentLatency.record(Date.now() - start);

    log.info('Payment successful', { transactionId: result.id, amount });
    res.json({ success: true, id: result.id });

  } catch (err) {
    // Metrics: Error (could use tags for status=error)
    log.error('Payment failed', err as Error, { amount });
    res.status(402).json({ error: 'Payment Failed' });
  }
});

// 4. Start Server & Simulate Traffic
const PORT = 3000;
const server = app.listen(PORT, async () => {
  console.log(`\n✅ Payment Service running on port ${PORT}`);
  console.log(`📝 Logs writing to ./payment-service.log`);
  console.log(`⚡️ Simulating traffic... Press Ctrl+C to stop.\n`);

  // Simulate traffic loop
  const simulateTraffic = async () => {
    const amount = Math.floor(Math.random() * 1500); // Random amount 0-1500
    try {
      await fetch(`http://localhost:${PORT}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          amount, 
          cardNumber: '4242-4242-4242-4242', // Should be redacted
          cvv: '123' 
        })
      });
    } catch (e) {}
    
    setTimeout(simulateTraffic, 1000 + Math.random() * 2000);
  };

  simulateTraffic();
});
