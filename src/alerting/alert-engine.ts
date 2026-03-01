import { randomUUID } from 'crypto';
import type {
  AlertRule,
  Alert,
  AlertCondition,
  LogEntry,
  Transport,
  ObserveConfig,
} from '../types';

const LOG_LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };

interface ErrorWindow {
  timestamps: number[];
}

export class AlertEngine {
  private readonly rules: AlertRule[];
  private readonly transports: Record<string, Transport>;
  private readonly predicates: Record<string, (entry: LogEntry) => boolean>;
  private readonly lastFired = new Map<string, number>();
  private readonly errorWindows = new Map<string, ErrorWindow>();
  private static readonly RATE_WINDOW_MS = 60_000;

  constructor(config: ObserveConfig) {
    this.rules = config.alerting?.rules ?? [];
    this.transports = config.alerting?.transports ?? {};
    this.predicates = config.alerting?.predicates ?? {};
  }

  async evaluate(entry: LogEntry): Promise<void> {
    const now = Date.now();

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (!this.shouldEvaluate(rule.id, now, rule.cooldownMs)) continue;

      const triggered = this.checkCondition(rule.condition, entry, rule.id, now);
      if (!triggered) continue;

      this.lastFired.set(rule.id, now);

      const alert: Alert = {
        id: randomUUID(),
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        message: this.buildAlertMessage(rule, entry),
        triggeredAt: new Date().toISOString(),
        context: {
          logLevel: entry.level,
          service: entry.service,
          traceId: entry.traceId,
          originalMessage: entry.message,
          ...entry.context,
        },
      };

      await this.fanout(alert, rule.channels);
    }
  }

  async trigger(
    rule: Pick<AlertRule, 'id' | 'name' | 'severity' | 'channels'>,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void> {
    const alert: Alert = {
      id: randomUUID(),
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      message,
      triggeredAt: new Date().toISOString(),
      context,
    };
    await this.fanout(alert, rule.channels);
  }

  private checkCondition(
    condition: AlertCondition,
    entry: LogEntry,
    ruleId: string,
    now: number
  ): boolean {
    switch (condition.type) {
      case 'log_level': {
        if (!condition.level) return false;
        return LOG_LEVEL_ORDER[entry.level] >= LOG_LEVEL_ORDER[condition.level];
      }

      case 'error_rate': {
        if (typeof condition.threshold !== 'number') return false;

        let window = this.errorWindows.get(ruleId);
        if (!window) {
          window = { timestamps: [] };
          this.errorWindows.set(ruleId, window);
        }

        if (LOG_LEVEL_ORDER[entry.level] >= LOG_LEVEL_ORDER['error']) {
          window.timestamps.push(now);
        }

        const cutoff = now - AlertEngine.RATE_WINDOW_MS;
        window.timestamps = window.timestamps.filter((t) => t > cutoff);

        return window.timestamps.length >= condition.threshold;
      }

      case 'latency': {
        if (typeof condition.latencyMs !== 'number') return false;
        return (entry.durationMs ?? 0) >= condition.latencyMs;
      }

      case 'custom': {
        const predicate = this.predicates[condition.predicateKey ?? ''];
        return predicate ? predicate(entry) : false;
      }

      default:
        return false;
    }
  }

  private shouldEvaluate(ruleId: string, now: number, cooldownMs: number): boolean {
    const last = this.lastFired.get(ruleId);
    if (!last) return true;
    return now - last >= cooldownMs;
  }

  private buildAlertMessage(rule: AlertRule, entry: LogEntry): string {
    return `[${rule.severity.toUpperCase()}] Rule "${rule.name}" triggered — ${entry.level.toUpperCase()}: ${entry.message}`;
  }

  private async fanout(alert: Alert, channelIds: string[]): Promise<void> {
    const targets = channelIds
      .map((id) => ({ id, transport: this.transports[id] }))
      .filter((target) => Boolean(target.transport));

    const results = await Promise.allSettled(
      targets.map((target) => target.transport!.sendAlert(alert))
    );

    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        process.stderr.write(
          JSON.stringify({
            level: 'error',
            message: `AlertEngine: transport "${targets[i].id}" failed`,
            error: String(result.reason),
          }) + '\n'
        );
      }
    });
  }
}
