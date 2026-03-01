import sqlite3 from 'sqlite3';
import { LogEntry, MetricValue, MetricsStorage } from '../types';

export class SQLiteStorage implements MetricsStorage {
  private db: sqlite3.Database;

  constructor(filePath: string = 'observa.db') {
    this.db = new sqlite3.Database(filePath, (err) => {
      if (err) {
        console.error('Could not connect to database', err);
      } else {
        this.init();
      }
    });
  }

  private init() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        type TEXT,
        value REAL,
        tags TEXT,
        timestamp TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT,
        message TEXT,
        service TEXT,
        context TEXT,
        timestamp TEXT
      )
    `);
  }

  saveMetric(metric: MetricValue) {
    this.db.run(
      `INSERT INTO metrics (name, type, value, tags, timestamp) VALUES (?, ?, ?, ?, ?)`,
      [metric.name, metric.type, metric.value, JSON.stringify(metric.tags), metric.timestamp]
    );
  }

  saveLog(log: LogEntry) {
    this.db.run(
      `INSERT INTO logs (level, message, service, context, timestamp) VALUES (?, ?, ?, ?, ?)`,
      [log.level, log.message, log.service, JSON.stringify(log.context), log.timestamp]
    );
  }

  async getMetrics(limit: number = 100): Promise<MetricValue[]> {
    return new Promise((resolve, reject) => {
      this.db.all(`SELECT * FROM metrics ORDER BY timestamp DESC LIMIT ?`, [limit], (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(row => ({
          ...row,
          tags: JSON.parse(row.tags)
        })) as MetricValue[]);
      });
    });
  }

  async getLogs(limit: number = 50): Promise<LogEntry[]> {
    return new Promise((resolve, reject) => {
      this.db.all(`SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?`, [limit], (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(row => ({
          ...row,
          context: JSON.parse(row.context)
        })) as LogEntry[]);
      });
    });
  }
}
