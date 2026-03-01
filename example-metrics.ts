
import { ObserveSDK, ConsoleTransport } from './src/index';

// 1. Initialize with Metrics enabled
const observe = ObserveSDK.init({
  service: 'metrics-demo',
  logging: {
    level: 'info',
    transports: [new ConsoleTransport()]
  },
  metrics: {
    enabled: true,
    intervalMs: 5000, // Flush every 5 seconds for demo
    logLevel: 'info', // Log metrics at INFO level
    system: true      // Enable CPU/Memory auto-collection
  }
});

console.log('--- Metrics Demo Started ---');
console.log('Collecting system metrics and custom counters...');

// 2. Create Custom Metrics
const requestCounter = observe.metrics.counter('http.requests', { env: 'prod' });
const activeUsers = observe.metrics.gauge('app.users.active');
const responseTime = observe.metrics.histogram('http.response_time_ms');

// 3. Simulate Activity
setInterval(() => {
  // Increment counter
  requestCounter.inc();
  
  // Update gauge (random value)
  const users = Math.floor(Math.random() * 100);
  activeUsers.set(users);
  
  // Record histogram values (random latency)
  const latency = 20 + Math.random() * 200;
  responseTime.record(latency);
  
}, 1000); // Generate data every second

// The SDK will automatically flush metrics every 5 seconds (intervalMs)
// You will see 'metrics.flush' logs in the console.

// Keep process alive
setTimeout(() => {
  console.log('--- Demo Finished ---');
  process.exit(0);
}, 16000);
