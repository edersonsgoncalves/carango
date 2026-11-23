/**
 * Teste E2E headless: sobe o Chromium via CDP puro (sem dependências) e
 * percorre as 8 telas do Carango Web validando conteúdo e erros de console.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_BIN ||
  `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;
const BASE = process.env.BASE_URL || 'http://localhost:3210';
const PORT = 9400 + Math.floor(Math.random() * 500);

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}`);
  if (!cond) failures++;
};

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`, '--window-size=1440,900', '--hide-scrollbars',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d; });

  // espera o endpoint de depuração
  let targets = null;
  for (let i = 0; i < 60 && !targets; i++) {
    await sleep(250);
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); }
    catch { /* ainda subindo */ }
  }
  if (!targets) throw new Error(`Chromium não subiu: ${chromeErr.slice(-400)}`);

  // cria uma aba (o socket da /json/version é do navegador, não da página)
  const page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws falhou')); });

  let seq = 0;
  const pending = new Map();
  const errors = [];
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method) {
      events.push(msg);
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push('exception: ' + (msg.params.exceptionDetails?.text || ''));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        errors.push('log: ' + msg.params.entry.text);
      }
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const goto = async (hash) => {
    await evaluate(`location.hash = ${JSON.stringify(hash)}; true`);
    await sleep(450);
  };
  const text = () => evaluate('document.body.innerText');
  const setValue = async (selector, value) => {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  console.log('\n== Navegação inicial ==');
  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(1500);
  let t = await text();
  ok(t.includes('Controle de abastecimentos'), 'tela de login renderiza');
  ok(t.includes('demo@carango.app'), 'credenciais demo exibidas');

  console.log('\n== Login ==');
  await setValue('#f_email', 'demo@carango.app');
  await setValue('#f_password', 'carango123');
  ok(await evaluate(`!!document.querySelector('#authForm')`), 'formulário #authForm existe');
  await evaluate(`document.querySelector('#authForm').requestSubmit(); true`);
  await sleep(1500);
  t = await text();
  ok((await evaluate(`document.getElementById('pageTitle')?.textContent`)) === 'Início', 'login entra no dashboard');
  ok(t.includes('Ações rápidas'), 'dashboard renderiza ações rápidas');
  ok(t.includes('Resumo'), 'dashboard renderiza resumo');
  ok(t.includes('Eficiência média'), 'dashboard renderiza eficiência');
  ok(t.includes('Gol'), 'dashboard lista o veículo');

  console.log('\n== Telas ==');
  const screens = [
    ['#/history', 'Histórico', ['Histórico', 'Exportar CSV', 'Todos os tipos']],
    ['#/reports', 'Relatórios', ['Relatórios', 'Gastos mensais', 'Eficiência por tanque cheio']],
    ['#/reminders', 'Lembretes', ['Lembretes', 'Manutenção, revisões']],
    ['#/vehicles', 'Veículos', ['Veículos', 'Gol', 'Novo veículo']],
    ['#/settings', 'Cadastros', ['Cadastros', 'Listas de apoio']],
    ['#/account', 'Configurações', ['Configurações', 'demo@carango.app', 'Sair da conta']],
    ['#/novo', 'Novo registro', ['Novo registro', 'Abastecimento', 'Percurso']],
    ['#/dashboard', 'Dashboard', ['Ações rápidas', 'Próximos lembretes']],
  ];
  for (const [hash, name, needles] of screens) {
    await goto(hash);
    t = await text();
    const missing = needles.filter((n) => !t.includes(n));
    ok(missing.length === 0, `tela ${name}${missing.length ? ' — faltando: ' + missing.join(', ') : ''}`);
  }

  console.log('\n== Filtros do histórico ==');
  await goto('#/history');
  await evaluate(`(() => {
    const s = document.querySelector('#hType');
    if (!s) return false;
    s.value = 'expense';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(700);
  t = await text();
  ok(t.includes('Oficina') || t.includes('Estacionamento'), 'filtro por tipo lista despesas');
  ok(!t.includes('Posto'), 'filtro esconde abastecimentos');

  console.log('\n== CRUD via UI (novo lembrete) ==');
  await goto('#/reminders');
  const before = await evaluate(`document.querySelectorAll('#content tbody tr').length`);
  await evaluate(`document.querySelector('#btnNew')?.click(); true`);
  await sleep(500);
  ok(await evaluate(`!!document.querySelector('#mform')`), 'modal de novo lembrete abre');
  await setValue('#f_title', 'Lembrete E2E');
  await setValue('#f_due_date', '2030-01-15');
  await evaluate(`document.querySelector('#mform').requestSubmit(); true`);
  await sleep(1200);
  const after = await evaluate(`document.querySelectorAll('#content tbody tr').length`);
  ok(after > before, `lembrete criado via UI (${before} → ${after} linhas)`);
  ok((await text()).includes('Lembrete E2E'), 'novo lembrete aparece na lista');

  console.log('\n== Persistência (reload) ==');
  await send('Page.navigate', { url: `${BASE}/#/dashboard` });
  await sleep(1800);
  t = await text();
  ok(t.includes('Ações rápidas'), 'sessão persiste após reload (token)');
  await goto('#/reminders');
  ok((await text()).includes('Lembrete E2E'), 'registro sobrevive ao reload (SQLite)');

  console.log('\n== Erros de console ==');
  const realErrors = errors.filter((e) =>
    !e.includes('favicon') && !e.includes('net::ERR') && !e.includes('404') &&
    !e.includes('401 (Unauthorized)')); // /api/me 401 antes do login é esperado
  ok(realErrors.length === 0, `sem erros JS${realErrors.length ? ':\n      ' + realErrors.join('\n      ') : ''}`);

  console.log('\n== Screenshot ==');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  const path = '/tmp/opencode/carango-e2e.png';
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  console.log(`  → ${path}`);

  ws.close();
  chrome.kill('SIGKILL');
  console.log(failures ? `\nFALHOU: ${failures} asserção(ões)` : '\nTODOS OS TESTES PASSARAM');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('ERRO:', err.message);
  process.exit(1);
});
