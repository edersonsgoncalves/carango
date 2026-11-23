// Minimal CDP driver using Node's global WebSocket — used to smoke-test the
// app end to end (login, navigation, forms) and capture screenshots.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = '/home/ed/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:3210';
const OUT = process.env.OUT || '/tmp/opencode/e2e';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const port = 9333 + Math.floor(Math.random() * 500);
  const proc = spawn(CHROME, [
    '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + port, '--window-size=1440,900',
    '--user-data-dir=' + path.join(OUT, 'profile-' + port),
    '--no-first-run', '--disable-features=Translate,BackForwardCache',
    'about:blank',
  ], { stdio: 'ignore' });

  let list;
  for (let i = 0; i < 60; i++) {
    try {
      list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (list.length) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!list || !list.length) throw new Error('CDP não subiu');
  return { proc, port, target: list.find((t) => t.type === 'page') };
}

class CDP {
  constructor(wsUrl) {
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ws = new WebSocket(wsUrl);
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        this.events.push(m);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    }
    return r.result?.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    return path.join(OUT, name + '.png');
  }
  consoleErrors() {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)))
      .map((e) => e.method === 'Runtime.exceptionThrown'
        ? e.params.exceptionDetails.exception?.description || JSON.stringify(e.params.exceptionDetails)
        : e.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  close() { try { this.ws.close(); } catch {} }
}

module.exports = { launch, CDP, sleep, BASE, OUT };
