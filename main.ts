// The World Today — 26 November 2026 (Node 22+ stdlib only).
// Renders page.html in headless Chromium over CDP and writes entry.png.
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// Outside the grader, MAKEFUN_OUTPUT_DIR stands in for /output.
// The render is deterministic: static local HTML, no scripts, no network,
// no timestamps — two runs produce byte-identical PNGs.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const pageUrl = 'file://' + join(root, 'page.html');

function findChrome(): string {
  const home = process.env.HOME ?? '';
  const candidates = [
    join(home, '.cache/ms-playwright/chromium-1255/chrome-linux64/chrome'),
    join(home, '.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell'),
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('no Chromium binary found');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<any> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('DevTools endpoint did not come up: ' + url);
}

async function main(): Promise<void> {
  const chrome = findChrome();
  const profile = join(tmpdir(), 'news-image-20261126-profile');
  const port = 9333;
  const child = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=1024,1024', 'about:blank',
  ], { stdio: 'ignore' });

  const errors: string[] = [];
  const nonLocal: string[] = [];
  try {
    const version = await getJson(`http://127.0.0.1:${port}/json/version`);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('CDP websocket failed'));
    });

    let nextId = 1;
    const pending = new Map<number, (v: any) => void>();
    const events: any[] = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      } else if (msg.method) {
        events.push(msg);
      }
    };
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<any>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, (msg) => (msg.error ? reject(new Error(method + ': ' + JSON.stringify(msg.error))) : resolve(msg.result)));
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    const target = await send('Target.createTarget', { url: pageUrl });
    const session = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = session.sessionId;
    const ssend = (method: string, params: Record<string, unknown> = {}) => send(method, params, sessionId);
    await ssend('Page.enable');
    await ssend('Emulation.setDeviceMetricsOverride', { width: 1024, height: 1024, deviceScaleFactor: 1, mobile: false });
    await ssend('Runtime.enable');
    await ssend('Network.enable');
    await ssend('Log.enable');
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (events.some((e) => e.method === 'Page.loadEventFired' && e.sessionId === sessionId)) {
          clearInterval(iv);
          resolve();
        }
      }, 50);
      setTimeout(() => { clearInterval(iv); resolve(); }, 10000);
    });
    await sleep(600);

    for (const e of events) {
      if (e.sessionId !== sessionId) continue;
      if (e.method === 'Runtime.exceptionThrown') errors.push('exception: ' + JSON.stringify(e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text));
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') errors.push('console.error: ' + JSON.stringify(e.params.args));
      if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') errors.push('log: ' + e.params.entry.text + ' ' + (e.params.entry.url ?? ''));
      if (e.method === 'Network.loadingFailed') errors.push('request failed: ' + (e.params.errorText ?? ''));
      if (e.method === 'Network.requestWillBeSent') {
        const url: string = e.params.request?.url ?? '';
        if (url && !url.startsWith('file://') && !url.startsWith('data:') && !url.startsWith('blob:')) nonLocal.push(url);
      }
    }

    const metrics = await ssend('Runtime.evaluate', {
      expression: `JSON.stringify({sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, pageH: document.querySelector('.page').scrollHeight, footerBottom: document.querySelector('.footer').getBoundingClientRect().bottom})`,
      returnByValue: true,
    });
    const m = JSON.parse(metrics.result.value);
    if (m.sw > 1024 || m.sh > 1024) errors.push(`overflow: scroll ${m.sw}x${m.sh} exceeds 1024x1024`);
    if (m.pageH > 1024) errors.push(`overflow: .page content is ${m.pageH}px tall, clipped at 1024`);
    if (m.footerBottom > 1014) errors.push(`overflow: footer bottom at ${m.footerBottom}px, cut off at 1024`);
    const shot = await ssend('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const png = Buffer.from(shot.data, 'base64');
    if (png.length > 1024 * 1024) errors.push(`size: entry.png is ${png.length} bytes, over the 1 MiB cap`);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'entry.png'), png);
    writeFileSync(join(root, 'entry.png'), png);
    const sha = createHash('sha256').update(png).digest('hex');
    console.log(JSON.stringify({ size: png.length, sha256: sha, page: `${m.sw}x${m.sh}`, consoleErrors: errors.length, nonLocalRequests: nonLocal.length }));
    if (errors.length) throw new Error('render checks failed: ' + errors.join(' | '));
    if (nonLocal.length) throw new Error('non-local requests: ' + nonLocal.join(', '));
  } finally {
    child.kill('SIGKILL');
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
