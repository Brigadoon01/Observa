import * as os from 'os';
import { MetricsEngine } from './metrics-engine';

export class SystemMonitor {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number = 60_000;

  constructor(private readonly metrics: MetricsEngine, intervalMs: number = 60_000) {
    this.intervalMs = intervalMs;
  }

  start() {
    if (this.timer) return;
    
    // Initial collection
    this.collect();
    
    this.timer = setInterval(() => {
      this.collect();
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private collect() {
    const mem = process.memoryUsage();
    this.metrics.gauge('process.memory.rss', { unit: 'bytes' }).set(mem.rss);
    this.metrics.gauge('process.memory.heap_used', { unit: 'bytes' }).set(mem.heapUsed);
    this.metrics.gauge('process.memory.heap_total', { unit: 'bytes' }).set(mem.heapTotal);
    
    const load = os.loadavg();
    this.metrics.gauge('system.load.1m').set(load[0]);
    this.metrics.gauge('system.load.5m').set(load[1]);
    this.metrics.gauge('system.load.15m').set(load[2]);
    
    this.metrics.gauge('process.uptime', { unit: 'seconds' }).set(process.uptime());
  }
}
