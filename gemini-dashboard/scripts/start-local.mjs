import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkspaceBridgeMiddleware } from '../lib/workspace-node-bridge.ts';

// Wrangler serves the built vinext application. Filesystem-backed APIs use
// the same host Node adapter as development; workerd has a virtual filesystem.
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const port = Number(option('--port', '3000'));
const host = option('--host', '127.0.0.1');
const probe = net.createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
const runtimePort = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const runtime = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
  'dev', '--config', 'dist/server/wrangler.json', '--ip', '127.0.0.1', '--port', String(runtimePort),
], { cwd: root, stdio: 'inherit', windowsHide: true });
const bridge = createWorkspaceBridgeMiddleware();
const server = http.createServer((req, res) => bridge(req, res, () => {
  const upstream = http.request({ hostname: '127.0.0.1', port: runtimePort, path: req.url, method: req.method, headers: req.headers }, response => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end('Local runtime unavailable'); });
  req.pipe(upstream);
}));
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  server.close();
  if (runtime.pid && runtime.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(runtime.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else runtime.kill('SIGTERM');
  }
  process.exit(code);
}
runtime.on('error', error => { console.error(error.message); stop(1); });
runtime.on('exit', code => stop(code ?? 1));
server.on('error', error => { console.error(error.message); stop(1); });
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
server.listen(port, host, () => console.log(`Local start PID=${process.pid} port=${port}; Wrangler PID=${runtime.pid} port=${runtimePort}`));
