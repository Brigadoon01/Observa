import type { ObserveConfig, Logger } from '../index';
import type { MetricValue, MetricType, LogLevel } from '../types';

interface MetricKey {
  name: string;
  tagsStr: string;
}

export class Counter {
  private value = 0;
  constructor(public readonly name: string, public readonly tags: Record<string, string> = {}) {}

  inc(amount = 1): void {
    this.value += amount;
  }

  getAndReset(): number {
    const v = this.value;
    this.value = 0;
    return v;
  }
}

export class Gauge {
  private value = 0;
  constructor(public readonly name: string, public readonly tags: Record<string, string> = {}) {}

  set(value: number): void {
    this.value = value;
  }

  get(): number {
    return this.value;
  }
}

export class Histogram {
  private values: number[] = [];
  constructor(public readonly name: string, public readonly tags: Record<string, string> = {}) {}

  record(value: number): void {
    this.values.push(value);
  }

  getAndReset(): { min: number; max: number; avg: number; count: number; p95: number } | null {
    if (this.values.length === 0) return null;

    const sorted = this.values.sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const count = sorted.length;
    const min = sorted[0];
    const max = sorted[count - 1];
    const avg = sum / count;
    const p95Index = Math.floor(count * 0.95);
    const p95 = sorted[p95Index];

    this.values = [];
    return { min, max, avg, count, p95 };
  }
}

export class MetricsEngine {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private readonly logLevel: LogLevel;
  private timer: NodeJS.Timeout | null = null;

  constructor(config: ObserveConfig, logger: Logger) {
    this.logger = logger;
    this.enabled = config.metrics?.enabled ?? true;
    this.intervalMs = config.metrics?.intervalMs ?? 60_000;
    this.logLevel = config.metrics?.logLevel ?? 'info';

    if (this.enabled) {
      this.startFlushTimer();
    }
  }

  private getKey(name: string, tags: Record<string, string>): string {
    const sortedTags = Object.keys(tags).sort().map(k => `${k}=${tags[k]}`).join(',');
    return `${name}|${sortedTags}`;
  }

  counter(name: string, tags: Record<string, string> = {}): Counter {
    const key = this.getKey(name, tags);
    let counter = this.counters.get(key);
    if (!counter) {
      counter = new Counter(name, tags);
      this.counters.set(key, counter);
    }
    return counter;
  }

  gauge(name: string, tags: Record<string, string> = {}): Gauge {
    const key = this.getKey(name, tags);
    let gauge = this.gauges.get(key);
    if (!gauge) {
      gauge = new Gauge(name, tags);
      this.gauges.set(key, gauge);
    }
    return gauge;
  }

  histogram(name: string, tags: Record<string, string> = {}): Histogram {
    const key = this.getKey(name, tags);
    let hist = this.histograms.get(key);
    if (!hist) {
      hist = new Histogram(name, tags);
      this.histograms.set(key, hist);
    }
    return hist;
  }

  private startFlushTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.flush(), this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  flush() {
    const metrics: MetricValue[] = [];
    const timestamp = new Date().toISOString();

    // Collect Counters
    for (const counter of this.counters.values()) {
      const val = counter.getAndReset();
      if (val > 0) {
        metrics.push({ name: counter.name, type: 'counter', value: val, tags: counter.tags, timestamp });
      }
    }

    // Collect Gauges
    for (const gauge of this.gauges.values()) {
      metrics.push({ name: gauge.name, type: 'gauge', value: gauge.get(), tags: gauge.tags, timestamp });
    }

    // Collect Histograms
    for (const hist of this.histograms.values()) {
      const stats = hist.getAndReset();
      if (stats) {
        // Emit summary metrics
        metrics.push({ name: `${hist.name}.count`, type: 'gauge', value: stats.count, tags: hist.tags, timestamp });
        metrics.push({ name: `${hist.name}.avg`, type: 'gauge', value: stats.avg, tags: hist.tags, timestamp });
        metrics.push({ name: `${hist.name}.p95`, type: 'gauge', value: stats.p95, tags: hist.tags, timestamp });
      }
    }

    if (metrics.length === 0) return;

    // Log metrics
    // We log them as a special event type so backends can parse them
    if (this.logLevel === 'debug') {
      this.logger.debug('metrics.flush', { metricsCount: metrics.length, metrics });
    } else if (this.logLevel === 'warn') {
      this.logger.warn('metrics.flush', { metricsCount: metrics.length, metrics });
    } else if (this.logLevel === 'error') {
      this.logger.error('metrics.flush', undefined, { metricsCount: metrics.length, metrics });
    } else if (this.logLevel === 'fatal') {
      this.logger.fatal('metrics.flush', undefined, { metricsCount: metrics.length, metrics });
    } else {
      this.logger.info('metrics.flush', { metricsCount: metrics.length, metrics });
    }
  }
}
