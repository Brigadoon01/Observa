
// ============================================================
// Example — Custom Transport Integration
// Shows: How to send logs/alerts to a custom backend
// ============================================================

import { ObserveSDK, Transport, LogEntry, Alert } from './src/index';

// 1. Define your custom transport
class MyCustomPlatformTransport implements Transport {
  readonly id = 'my-custom-platform';
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  // Handle incoming logs
  async send(entry: LogEntry): Promise<void> {
    // In a real app, you'd probably batch these
    console.log(`[CustomTransport] Sending log to external platform: ${entry.message}`);
    
    // Example fetch to external API
    // await fetch('https://api.my-observability.com/logs', {
    //   method: 'POST',
    //   headers: { 'Authorization': `Bearer ${this.apiKey}` },
    //   body: JSON.stringify(entry)
    // });
  }

  // Handle incoming alerts
  async sendAlert(alert: Alert): Promise<void> {
    console.log(`[CustomTransport] 🚨 Sending ALERT to external platform: ${alert.message}`);
    
    // Example fetch to external API
    // await fetch('https://api.my-observability.com/alerts', {
    //   method: 'POST',
    //   headers: { 'Authorization': `Bearer ${this.apiKey}` },
    //   body: JSON.stringify(alert)
    // });
  }
}

// 2. Initialize SDK with your custom transport
const observe = ObserveSDK.init({
  service: 'demo-service',
  logging: {
    level: 'info',
    transports: [
      new MyCustomPlatformTransport('secret-api-key')
    ]
  },
  alerting: {
    rules: [{
      id: 'demo-alert',
      name: 'Demo Alert',
      condition: { type: 'log_level', level: 'error' },
      severity: 'high',
      channels: ['custom-channel'], // match the transport key below
      cooldownMs: 0,
      enabled: true
    }],
    transports: {
      'custom-channel': new MyCustomPlatformTransport('secret-api-key')
    }
  }
});

// 3. Usage
async function run() {
  console.log('--- Starting Custom Transport Demo ---');
  
  // This log will be handled by MyCustomPlatformTransport.send()
  observe.logger.info('Hello from custom transport!');
  
  // This error will trigger the alert rule, handled by MyCustomPlatformTransport.sendAlert()
  observe.logger.error('Something went wrong!');
  
  // Allow time for async transport to finish (since it's not awaited in logger)
  await new Promise(resolve => setTimeout(resolve, 100));
}

run();
