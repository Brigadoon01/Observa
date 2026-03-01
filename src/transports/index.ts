import { appendFile } from 'fs/promises';
import type { Transport, LogEntry, Alert } from '../types';

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export class ConsoleTransport implements Transport {
  readonly id = 'console';

  async send(entry: LogEntry): Promise<void> {
    void entry;
  }

  async sendAlert(alert: Alert): Promise<void> {
    console.warn(
      `\x1b[31m[ALERT][${alert.severity.toUpperCase()}]\x1b[0m ${alert.triggeredAt} — ${alert.message}`
    );
  }
}

export interface FileTransportOptions {
  id?: string;
  filePath: string;
  alertFilePath?: string;
}

export class FileTransport implements Transport {
  readonly id: string;
  private readonly filePath: string;
  private readonly alertFilePath: string;

  constructor(options: FileTransportOptions) {
    this.id = options.id ?? 'file';
    this.filePath = options.filePath;
    this.alertFilePath = options.alertFilePath ?? options.filePath;
  }

  async send(entry: LogEntry): Promise<void> {
    await appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
  }

  async sendAlert(alert: Alert): Promise<void> {
    await appendFile(this.alertFilePath, JSON.stringify(alert) + '\n', 'utf8');
  }
}

export interface HttpTransportOptions {
  id?: string;
  url: string;
  headers?: Record<string, string>;
  batchSize?: number;
  flushIntervalMs?: number;
  timeoutMs?: number;
}

export class HttpTransport implements Transport {
  readonly id: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly timeoutMs: number;
  private buffer: LogEntry[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(options: HttpTransportOptions) {
    this.id = options.id ?? 'http';
    this.url = options.url;
    this.headers = { 'Content-Type': 'application/json', ...options.headers };
    this.batchSize = options.batchSize ?? 20;
    this.flushIntervalMs = options.flushIntervalMs ?? 2000;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async send(entry: LogEntry): Promise<void> {
    this.buffer.push(entry);
    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  async sendAlert(alert: Alert): Promise<void> {
    await fetchWithTimeout(
      this.url,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ type: 'alert', ...alert }),
      },
      this.timeoutMs
    );
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer.length) return;

    const batch = this.buffer.splice(0);
    await fetchWithTimeout(
      this.url,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(batch),
      },
      this.timeoutMs
    );
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), this.flushIntervalMs);
  }
}

export interface SlackTransportOptions {
  id?: string;
  webhookUrl: string;
  minSeverity?: 'low' | 'medium' | 'high' | 'critical';
  timeoutMs?: number;
}

const SEVERITY_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };
const SEVERITY_EMOJI: Record<string, string> = {
  low: ':information_source:',
  medium: ':warning:',
  high: ':rotating_light:',
  critical: ':fire:',
};

export class SlackTransport implements Transport {
  readonly id: string;
  private readonly webhookUrl: string;
  private readonly minSeverity: number;
  private readonly timeoutMs: number;

  constructor(options: SlackTransportOptions) {
    this.id = options.id ?? 'slack';
    this.webhookUrl = options.webhookUrl;
    this.minSeverity = SEVERITY_ORDER[options.minSeverity ?? 'high'];
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async send(_entry: LogEntry): Promise<void> {}

  async sendAlert(alert: Alert): Promise<void> {
    if (SEVERITY_ORDER[alert.severity] < this.minSeverity) return;

    const emoji = SEVERITY_EMOJI[alert.severity] ?? ':bell:';
    const payload = {
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `${emoji} ${alert.ruleName} — ${alert.severity.toUpperCase()}`,
          },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: alert.message },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Alert ID:*\n${alert.id}` },
            { type: 'mrkdwn', text: `*Triggered:*\n${alert.triggeredAt}` },
            ...(alert.context?.traceId
              ? [{ type: 'mrkdwn', text: `*Trace ID:*\n${alert.context.traceId}` }]
              : []),
          ],
        },
      ],
    };

    await fetchWithTimeout(
      this.webhookUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      this.timeoutMs
    );
  }
}

export interface WebhookTransportOptions {
  id?: string;
  url: string;
  headers?: Record<string, string>;
  includeLogs?: boolean;
  timeoutMs?: number;
}

export class WebhookTransport implements Transport {
  readonly id: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly includeLogs: boolean;
  private readonly timeoutMs: number;

  constructor(options: WebhookTransportOptions) {
    this.id = options.id ?? 'webhook';
    this.url = options.url;
    this.headers = { 'Content-Type': 'application/json', ...options.headers };
    this.includeLogs = options.includeLogs ?? false;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async send(entry: LogEntry): Promise<void> {
    if (!this.includeLogs) return;
    await fetchWithTimeout(
      this.url,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ type: 'log', ...entry }),
      },
      this.timeoutMs
    );
  }

  async sendAlert(alert: Alert): Promise<void> {
    await fetchWithTimeout(
      this.url,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ type: 'alert', ...alert }),
      },
      this.timeoutMs
    );
  }
}

export interface PagerDutyTransportOptions {
  id?: string;
  integrationKey: string;
  severities?: Array<'low' | 'medium' | 'high' | 'critical'>;
  timeoutMs?: number;
}

const PAGERDUTY_SEVERITY_MAP: Record<string, string> = {
  low: 'info',
  medium: 'warning',
  high: 'error',
  critical: 'critical',
};

export class PagerDutyTransport implements Transport {
  readonly id: string;
  private readonly integrationKey: string;
  private readonly allowedSeverities: Set<string>;
  private readonly timeoutMs: number;

  constructor(options: PagerDutyTransportOptions) {
    this.id = options.id ?? 'pagerduty';
    this.integrationKey = options.integrationKey;
    this.allowedSeverities = new Set(options.severities ?? ['critical']);
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async send(_entry: LogEntry): Promise<void> {}

  async sendAlert(alert: Alert): Promise<void> {
    if (!this.allowedSeverities.has(alert.severity)) return;

    const payload = {
      routing_key: this.integrationKey,
      event_action: 'trigger',
      dedup_key: alert.ruleId,
      payload: {
        summary: alert.message,
        severity: PAGERDUTY_SEVERITY_MAP[alert.severity],
        timestamp: alert.triggeredAt,
        source: alert.context?.service ?? 'nodeobserve',
        custom_details: alert.context ?? {},
      },
    };

    await fetchWithTimeout(
      'https://events.pagerduty.com/v2/enqueue',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      this.timeoutMs
    );
  }
}
