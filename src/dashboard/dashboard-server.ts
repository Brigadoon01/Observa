import http from 'http';
import { Logger } from '../logger/logger';
import { MetricsEngine } from '../metrics/metrics-engine';
import { MetricValue, LogEntry, MetricsStorage } from '../types';
import { SQLiteStorage } from '../storage/sqlite-storage';

import jwt from 'jsonwebtoken';

export class DashboardServer {
  private server: http.Server | null = null;
  private clients: http.ServerResponse[] = [];
  private lastMetrics: MetricValue[] = [];
  private logBuffer: LogEntry[] = [];
  private storage: MetricsStorage;

  constructor(
    private readonly metricsEngine: MetricsEngine,
    private readonly logger: Logger,
    private readonly port: number = 3001,
    private readonly host: string = '0.0.0.0',
    private readonly auth?: { 
      type: 'basic' | 'jwt';
      user?: string; 
      pass?: string;
      jwtSecret?: string;
    },
    storage?: MetricsStorage
  ) {
    this.storage = storage || new SQLiteStorage();
  }

  start() {
    // 1. Hook into metrics engine
    this.metricsEngine.setOnFlush((metrics) => {
      this.lastMetrics = metrics;
      this.broadcastEvent('metrics', metrics);
      metrics.forEach(m => this.storage.saveMetric(m));
    });

    // 2. Hook into logger
    this.logger.setOnLog((entry) => {
      // Don't log metrics flush events to avoid loops/noise
      if (entry.message === 'metrics.flush') return;
      
      this.logBuffer.unshift(entry);
      if (this.logBuffer.length > 50) this.logBuffer.pop(); // Keep last 50 logs
      this.broadcastEvent('log', entry);
      this.storage.saveLog(entry);
    });

    // 3. Start Server
    this.server = http.createServer((req, res) => {
      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

      // Login Endpoint for JWT
      if (req.url === '/login' && req.method === 'POST') {
        this.handleLogin(req, res);
        return;
      }

      // Authentication Check
      if (this.auth) {
        // Basic Auth
        if (this.auth.type === 'basic') {
          const authHeader = req.headers.authorization;
          if (!authHeader) {
            res.setHeader('WWW-Authenticate', 'Basic realm="ObserveSDK Dashboard"');
            res.writeHead(401);
            res.end('Authentication required');
            return;
          }

          const b64auth = authHeader.split(' ')[1];
          const [user, pass] = Buffer.from(b64auth, 'base64').toString().split(':');

          if (user !== this.auth.user || pass !== this.auth.pass) {
            res.setHeader('WWW-Authenticate', 'Basic realm="ObserveSDK Dashboard"');
            res.writeHead(401);
            res.end('Invalid credentials');
            return;
          }
        } 
        // JWT Auth
        else if (this.auth.type === 'jwt') {
          // Allow access to login page and static assets without token
          if (req.url === '/' || req.url === '/index.html' || req.url === '/login') {
            // Pass through to serve dashboard (client-side will handle redirect if no token)
          } else {
            // Verify Token for API/SSE
            const authHeader = req.headers.authorization; // Bearer <token>
            const token = authHeader?.split(' ')[1] || this.getQueryParam(req.url || '', 'token');
            
            if (!token) {
              res.writeHead(401);
              res.end('Token required');
              return;
            }

            try {
              jwt.verify(token, this.auth.jwtSecret || 'default-secret');
            } catch (err) {
              res.writeHead(403);
              res.end('Invalid token');
              return;
            }
          }
        }
      }
      
      // Historical Data API
      if (req.url?.startsWith('/api/history/metrics')) {
        this.handleHistoricalMetrics(req, res);
        return;
      }

      if (req.url?.startsWith('/events')) {
        this.handleSSE(req, res);
      } else if (req.url === '/' || req.url === '/index.html') {
        this.serveDashboard(res);
      } else {
        res.statusCode = 404;
        res.end('Not Found');
      }
    });

    try {
      // Dynamic Port Handling
      this.server?.listen(this.port, this.host, () => {
        console.log(`📊 ObserveSDK Dashboard running at http://${this.host}:${this.port}`);
      }).on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`⚠️ Port ${this.port} is busy, trying ${this.port + 1}...`);
          // Hacky: Force cast to writable to update port (in real app, use a proper config update or separate variable)
          (this as any).port = this.port + 1;
          this.server?.listen(this.port, this.host);
        } else {
          console.error('Dashboard server error:', err);
        }
      });
    } catch (e) {
      // Fallback
      this.server?.listen(0, this.host, () => {
        console.log(`ObserveSDK Dashboard running on random port: http://${this.host}:${(this.server?.address() as any).port}`);
      });
    }
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private getQueryParam(url: string, key: string): string | null {
    const match = url.match(new RegExp(`[?&]${key}=([^&]*)`));
    return match ? match[1] : null;
  }

  private handleLogin(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { user, pass } = JSON.parse(body);
        // Simple check against config (in production, use DB)
        if (user === this.auth?.user && pass === this.auth?.pass) {
          const token = jwt.sign({ user }, this.auth?.jwtSecret || 'default-secret', { expiresIn: '1h' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token }));
        } else {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Invalid credentials' }));
        }
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid body');
      }
    });
  }

  private async handleHistoricalMetrics(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const metrics = await this.storage.getMetrics(500); // Last 500 points
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to fetch history' }));
    }
  }

  private handleSSE(req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // Send initial data if available
    if (this.lastMetrics.length > 0) {
      res.write(`event: metrics\ndata: ${JSON.stringify(this.lastMetrics)}\n\n`);
    }
    
    // Send recent logs
    this.logBuffer.forEach(log => {
      res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`);
    });

    this.clients.push(res);

    req.on('close', () => {
      this.clients = this.clients.filter(c => c !== res);
    });
  }

  private broadcastEvent(type: string, data: any) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    this.clients.forEach(client => client.write(payload));
  }

  private serveDashboard(res: http.ServerResponse) {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ObserveSDK Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 20px; background: #1a1a1a; color: #e0e0e0; }
        .container { max-width: 1200px; margin: 0 auto; }
        header { background: #333; color: white; padding: 1rem; border-radius: 8px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        .status { font-size: 0.9rem; color: #4caf50; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 20px; }
        .card { background: #2d2d2d; padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.2); border: 1px solid #404040; }
        h2 { margin-top: 0; font-size: 1.2rem; color: #f0f0f0; border-bottom: 1px solid #404040; padding-bottom: 10px; }
        .metric-value { font-size: 2rem; font-weight: bold; color: #64b5f6; }
        .metric-label { font-size: 0.9rem; color: #aaa; }
        canvas { width: 100% !important; height: 250px !important; }
        .log-list { max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 0.85rem; background: #1e1e1e; padding: 10px; border-radius: 4px; }
        .log-item { padding: 8px 0; border-bottom: 1px solid #333; display: flex; align-items: start; gap: 10px; }
        .log-time { color: #888; font-size: 0.75rem; white-space: nowrap; }
        .log-level { padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; text-transform: uppercase; }
        .level-info { background: #1565c0; color: white; }
        .level-warn { background: #ef6c00; color: white; }
        .level-error { background: #c62828; color: white; }
        .log-msg { word-break: break-all; color: #ddd; }
        #loginOverlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); display: none; justify-content: center; align-items: center; z-index: 1000; }
        .login-box { background: #2d2d2d; padding: 30px; border-radius: 8px; width: 300px; text-align: center; border: 1px solid #444; }
        .login-box input { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #444; background: #1a1a1a; color: white; border-radius: 4px; box-sizing: border-box; }
        .login-box button { width: 100%; padding: 10px; background: #1565c0; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }
        .login-box button:hover { background: #0d47a1; }
        .login-box h2 { border: none; }
    </style>
</head>
<body>
    <div id="loginOverlay">
        <div class="login-box">
            <h2>🔐 Login</h2>
            <input type="text" id="username" placeholder="Username" />
            <input type="password" id="password" placeholder="Password" />
            <button onclick="login()">Sign In</button>
            <p id="loginError" style="color: red; display: none; font-size: 0.9rem; margin-top: 10px;"></p>
        </div>
    </div>

    <div class="container">
        <header>
            <h1>🔍 ObserveSDK Dashboard</h1>
            <span class="status">● Live Connected</span>
        </header>

        <div class="grid">
            <!-- System Stats -->
            <div class="card">
                <h2>System Load (1m/5m/15m)</h2>
                <canvas id="loadChart"></canvas>
            </div>
            <div class="card">
                <h2>Memory Usage (MB)</h2>
                <canvas id="memoryChart"></canvas>
            </div>

            <!-- Custom Metrics -->
            <div class="card">
                <h2>Key Metrics</h2>
                <div id="keyMetrics">Waiting for data...</div>
            </div>
            
            <!-- Real-time Values -->
            <div class="card">
                <h2>Live Logs</h2>
                <div id="liveLogs" class="log-list"></div>
            </div>
        </div>
    </div>

    <script>
        const authType = '${this.auth?.type || 'none'}';
        let token = localStorage.getItem('observe_token');
        let evtSource = null;

        if (authType === 'jwt' && !token) {
            document.getElementById('loginOverlay').style.display = 'flex';
        } else {
            connectSSE();
        }

        async function login() {
            const user = document.getElementById('username').value;
            const pass = document.getElementById('password').value;
            
            try {
                const res = await fetch('/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user, pass })
                });
                
                if (res.ok) {
                    const data = await res.json();
                    localStorage.setItem('observe_token', data.token);
                    token = data.token;
                    document.getElementById('loginOverlay').style.display = 'none';
                    connectSSE();
                } else {
                    document.getElementById('loginError').style.display = 'block';
                    document.getElementById('loginError').innerText = 'Invalid Credentials';
                }
            } catch (e) {
                document.getElementById('loginError').innerText = 'Login Failed';
            }
        }

        function connectSSE() {
            const url = authType === 'jwt' ? \`/events?token=\${token}\` : '/events';
            
            // For JWT in header (EventSource doesn't support headers natively in all browsers, so we use query param or polyfill)
            // Here we use query param for simplicity in this zero-dependency setup
            evtSource = new EventSource(url, { withCredentials: true });
            
            evtSource.addEventListener('metrics', function(event) {
                const metrics = JSON.parse(event.data);
                const time = new Date().toLocaleTimeString();
                updateCharts(time, metrics);
                updateKeyMetrics(metrics);
            });

            evtSource.addEventListener('log', function(event) {
                try {
                    const log = JSON.parse(event.data);
                    addLog(log);
                } catch (e) {
                    console.error('Error parsing log event:', e);
                }
            });

            evtSource.onerror = (err) => {
                if (authType === 'jwt' && evtSource.readyState === EventSource.CLOSED) {
                    // Token likely expired
                    localStorage.removeItem('observe_token');
                    document.getElementById('loginOverlay').style.display = 'flex';
                }
            };
        }
        
        // Charts
        const loadCtx = document.getElementById('loadChart').getContext('2d');
        const loadChart = new Chart(loadCtx, {
            type: 'line',
            data: { labels: [], datasets: [
                { label: '1m', data: [], borderColor: '#ff6384', fill: false },
                { label: '5m', data: [], borderColor: '#36a2eb', fill: false },
                { label: '15m', data: [], borderColor: '#ffcd56', fill: false }
            ]},
            options: { animation: false, scales: { y: { beginAtZero: true } } }
        });

        const memCtx = document.getElementById('memoryChart').getContext('2d');
        const memChart = new Chart(memCtx, {
            type: 'line',
            data: { labels: [], datasets: [
                { label: 'RSS', data: [], borderColor: '#4bc0c0', fill: true },
                { label: 'Heap Used', data: [], borderColor: '#9966ff', fill: true }
            ]},
            options: { animation: false, scales: { y: { beginAtZero: true } } }
        });

        const MAX_POINTS = 20;



        function updateCharts(label, metrics) {
            // Add Label
            if (loadChart.data.labels.length > MAX_POINTS) loadChart.data.labels.shift();
            loadChart.data.labels.push(label);
            
            if (memChart.data.labels.length > MAX_POINTS) memChart.data.labels.shift();
            memChart.data.labels.push(label);

            // Update Datasets
            const load1 = metrics.find(m => m.name === 'system.load.1m')?.value || 0;
            const load5 = metrics.find(m => m.name === 'system.load.5m')?.value || 0;
            const load15 = metrics.find(m => m.name === 'system.load.15m')?.value || 0;
            
            const rss = (metrics.find(m => m.name === 'process.memory.rss')?.value || 0) / 1024 / 1024;
            const heap = (metrics.find(m => m.name === 'process.memory.heap_used')?.value || 0) / 1024 / 1024;

            updateDataset(loadChart, 0, load1);
            updateDataset(loadChart, 1, load5);
            updateDataset(loadChart, 2, load15);
            
            updateDataset(memChart, 0, rss);
            updateDataset(memChart, 1, heap);

            loadChart.update();
            memChart.update();
        }

        function updateDataset(chart, index, value) {
            const ds = chart.data.datasets[index];
            if (ds.data.length > MAX_POINTS) ds.data.shift();
            ds.data.push(value);
        }

        function updateKeyMetrics(metrics) {
            const container = document.getElementById('keyMetrics');
            let html = '';
            
            // Filter for non-system metrics
            const custom = metrics.filter(m => !m.name.startsWith('system.') && !m.name.startsWith('process.'));
            
            custom.forEach(m => {
                html += \`
                    <div style="margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 5px;">
                        <div class="metric-label">\${m.name} \${Object.keys(m.tags).length ? JSON.stringify(m.tags) : ''}</div>
                        <div class="metric-value">\${m.value.toLocaleString()}</div>
                    </div>
                \`;
            });
            
            if (!html) html = 'No custom metrics found.';
            container.innerHTML = html;
        }

        function addLog(log) {
            const list = document.getElementById('liveLogs');
            const div = document.createElement('div');
            div.className = 'log-item';
            
            const time = new Date(log.timestamp).toLocaleTimeString();
            const levelClass = 'level-' + log.level;
            
            div.innerHTML = \`
                <span class="log-time">\${time}</span>
                <span class="log-level \${levelClass}">\${log.level}</span>
                <span class="log-msg">\${log.message}</span>
            \`;
            
            list.insertBefore(div, list.firstChild);
            if (list.children.length > 50) list.removeChild(list.lastChild);
        }
    </script>
</body>
</html>
    `;
    
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }
}
