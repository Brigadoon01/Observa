import { Logger } from './logger/logger';
import { Tracer } from './tracer/tracer';
import { AlertEngine } from './alerting/alert-engine';
import { MetricsEngine } from './metrics/metrics-engine';
import { SystemMonitor } from './metrics/system-monitor';
import { createObserveMiddleware, ObserveMiddlewareOptions } from './middleware/express';
import type { ObserveConfig, LogEntry } from './types';

export * from './types';
export * from './logger/logger';
export * from './tracer/tracer';
export * from './tracer/exporters';
export * from './transports';
export * from './alerting/alert-engine';
export * from './metrics/metrics-engine';
export * from './middleware/express';

export class ObserveSDK {
  public readonly logger: Logger;
  public readonly tracer: Tracer;
  public readonly alertEngine: AlertEngine;
  public readonly metrics: MetricsEngine;
  private readonly systemMonitor?: SystemMonitor;
  private static instance: ObserveSDK;

  private constructor(config: ObserveConfig) {
    this.tracer = new Tracer(config);
    this.alertEngine = new AlertEngine(config);
    
    // Logger needs to be hooked up to AlertEngine
    const onEntry = async (entry: LogEntry) => {
      await this.alertEngine.evaluate(entry);
    };

    this.logger = new Logger(config, {}, onEntry);
    this.metrics = new MetricsEngine(config, this.logger);

    if (config.metrics?.system !== false) {
      this.systemMonitor = new SystemMonitor(
        this.metrics, 
        config.metrics?.intervalMs ?? 60_000
      );
      this.systemMonitor.start();
    }
  }

  public static init(config: ObserveConfig): ObserveSDK {
    if (ObserveSDK.instance) {
      // In a real app you might want to warn or throw if re-initialized
      return ObserveSDK.instance;
    }
    ObserveSDK.instance = new ObserveSDK(config);
    return ObserveSDK.instance;
  }

  public static getInstance(): ObserveSDK {
    if (!ObserveSDK.instance) {
      throw new Error('ObserveSDK not initialized. Call ObserveSDK.init() first.');
    }
    return ObserveSDK.instance;
  }

  public middleware(options?: ObserveMiddlewareOptions) {
    return createObserveMiddleware(this.logger, this.tracer, this.alertEngine, options);
  }
}
