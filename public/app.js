/* ==========================================================================
   Carango web — SPA
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- api ---------------------------------------------------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* csv / empty */ }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/register')) {
      state.user = null;
      renderAuth();
      throw new Error('Sessão expirada.');
    }
    throw new Error((data && data.error) || `Erro ${res.status}`);
  }
  return data;
}

/* ---------- formatting --------------------------------------------------- */
const fmtMoney = (v, d = 2) =>
  (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: d, maximumFractionDigits: d });
const fmtNum = (v, d = 1) => (v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtDate = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TYPE_META = {
  refueling: { label: 'Abastecimento', color: '#ff9800', icon: '⛽' },
  expense:   { label: 'Despesa',       color: '#e64a19', icon: '💸' },
  income:    { label: 'Receita',       color: '#2e7d32', icon: '💰' },
  service:   { label: 'Serviço',       color: '#795548', icon: '🔧' },
  route:     { label: 'Percurso',      color: '#607d8b', icon: '🛣️' },
  reading:   { label: 'Leitura',       color: '#c2185b', icon: '📍' },
  reminder:  { label: 'Lembrete',      color: '#673ab7', icon: '🔔' },
};

/* ---------- state -------------------------------------------------------- */
const state = {
  user: null,
  vehicles: [],
  vehicleId: Number(localStorage.getItem('vehicleId')) || 0,
  cache: {},
};

/* ---------- ui primitives ------------------------------------------------ */
function toast(msg, kind = '') {
  let box = $('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2600);
  setTimeout(() => t.remove(), 3000);
}

function modal(title, bodyHTML, onSubmit, opts = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="x" aria-label="Fechar">&times;</button></div>
      <div class="modal-body">
        <form id="mform">${bodyHTML}
          <div class="form-actions">
            <button type="button" class="btn ghost" data-cancel>Cancelar</button>
            <button type="submit" class="btn">Salvar</button>
          </div>
        </form>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  $('.x', ov).onclick = close;
  $('[data-cancel]', ov).onclick = close;
  const form = $('form', ov);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const body = {};
    for (const [k, v] of fd.entries()) {
      if (v === '' && form.elements[k]?.dataset.optional === '1') continue;
      body[k] = v;
    }
    // unchecked checkboxes are absent → treat explicitly named ones
    $$('input[type=checkbox][name]', form).forEach((c) => {
      if (!(c.name in body)) body[c.name] = 0;
      else body[c.name] = c.checked ? 1 : 0;
    });
    // numeric coercion
    $$('input[data-type=number], input[type=number]', form).forEach((i) => {
      if (i.name && i.value !== '') body[i.name] = Number(i.value);
      else if (i.name) delete body[i.name];
    });
    const btn = $('button[type=submit]', ov);
    btn.disabled = true;
    try {
      await onSubmit(body);
      close();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  };
  if (opts.onReady) opts.onReady(form, ov);
  const first = $('input:not([type=hidden]), select, textarea', ov);
  if (first) setTimeout(() => first.focus(), 40);
  return { close, form, ov };
}

function confirmDialog(message, onYes) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" style="max-width:430px">
      <div class="modal-head"><h3>Confirmar</h3><button class="x">&times;</button></div>
      <div class="modal-body">
        <p style="margin:0 0 18px;font-size:14.5px;line-height:1.55">${esc(message)}</p>
        <div class="form-actions">
          <button class="btn ghost" data-cancel>Cancelar</button>
          <button class="btn danger" data-yes>Excluir</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  $('.x', ov).onclick = close;
  $('[data-cancel]', ov).onclick = close;
  $('[data-yes]', ov).onclick = async () => { close(); await onYes(); };
}

function field(name, label, inputHTML, opts = {}) {
  return `
    <div class="field ${opts.full ? 'full' : ''}">
      <label for="f_${name}">${esc(label)}${opts.req ? ' <span class="req">*</span>' : ''}</label>
      ${inputHTML.replace('__ID__', `f_${name}`)}
      ${opts.help ? `<div class="help">${esc(opts.help)}</div>` : ''}
    </div>`;
}
const input = (name, attrs = '') => `<input id="__ID__" name="${name}" ${attrs}>`;
const select = (name, options, attrs = '') =>
  `<select id="__ID__" name="${name}" ${attrs}>${options.map((o) =>
    `<option value="${esc(o.v)}">${esc(o.t)}</option>`).join('')}</select>`;
const opt = (rows, labelKey = 'name') => (rows || []).map((r) => ({ v: r.id, t: r[labelKey] }));

const odoField = (name, label, opts = {}) => `
  <div class="field ${opts.full ? 'full' : ''}">
    <label for="f_${name}">${esc(label)}${opts.req ? ' <span class="req">*</span>' : ''} <span class="muted" data-odo-hint="${esc(name)}" style="font-weight:400"></span></label>
    <input id="f_${name}" name="${name}" type="number" step="${opts.step || '0.1'}" min="0" ${opts.req ? 'required' : ''} data-type="number" ${opts.optional ? 'data-optional="1"' : ''} value="${opts.value ?? ''}">
    ${opts.help ? `<div class="help">${esc(opts.help)}</div>` : ''}
  </div>`;

function wireOdoHints(form, getVehicleId) {
  const hints = form.querySelectorAll('[data-odo-hint]');
  if (!hints.length) return;
  const update = async () => {
    const vid = Number(typeof getVehicleId === 'function' ? getVehicleId() : (getVehicleId || form.elements['vehicle_id']?.value || 0));
    let last = null;
    if (vid) { try { last = (await api(`/api/last-odometer?vehicle_id=${vid}`)).odometer; } catch {} }
    hints.forEach((h) => { h.textContent = vid ? `| Último: ${last != null ? fmtNum(last, 0) : '—'}` : ''; });
  };
  form.elements['vehicle_id']?.addEventListener('change', update);
  update();
}

/* ---------- auth view ---------------------------------------------------- */
function renderAuth(mode = 'login') {
  document.title = 'Entrar · Carango';
  $('#app').innerHTML = `
    <div class="auth">
      <div class="auth-card">
        <div class="brand"><span class="logo">D</span> Carango</div>
        <p class="lead">Controle de abastecimentos, despesas e manutenção do seu veículo</p>
        <div class="auth-tabs">
          <button data-m="login" class="${mode === 'login' ? 'on' : ''}">Entrar</button>
          <button data-m="register" class="${mode === 'register' ? 'on' : ''}">Criar conta</button>
        </div>
        <form id="authForm">
          ${mode === 'register' ? field('name', 'Nome', input('name', 'required autocomplete="name" placeholder="Seu nome"')) : ''}
          ${field('email', 'E-mail', input('email', 'type="email" required autocomplete="email" placeholder="voce@email.com"'))}
          ${field('password', 'Senha', input('password', 'type="password" required minlength="6" autocomplete="' + (mode === 'login' ? 'current-password' : 'new-password') + '" placeholder="••••••••"'), { help: mode === 'register' ? 'Mínimo de 6 caracteres.' : '' })}
          <button class="btn" type="submit">${mode === 'login' ? 'Entrar' : 'Criar conta'}</button>
        </form>
        <div class="demo-hint">Conta demo · <b>demo@carango.app</b> / <b>carango123</b></div>
      </div>
    </div>`;

  $$('.auth-tabs button').forEach((b) => (b.onclick = () => renderAuth(b.dataset.m)));
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    try {
      state.user = await api(mode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body });
      await boot();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  };
}

/* ---------- app shell ---------------------------------------------------- */
function shell(contentHTML, active) {
  const nav = [
    { k: 'dashboard', t: 'Início', i: '🏠' },
    { k: 'history',   t: 'Histórico', i: '🕘' },
    { k: 'reports',   t: 'Relatórios', i: '📊' },
    { k: 'reminders', t: 'Lembretes', i: '🔔' },
    { k: 'vehicles',  t: 'Veículos',  i: '🚗' },
  ];
  const manage = [
    { k: 'settings', t: 'Cadastros', i: '🗂️' },
    { k: 'account',  t: 'Configurações', i: '⚙️' },
  ];
  const link = (n) =>
    `<a href="#/${n.k}" class="${active === n.k ? 'active' : ''}"><span class="ico">${n.i}</span>${n.t}</a>`;

  $('#app').innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><span class="logo">D</span> Carango</div>
        <nav class="nav">
          ${nav.map(link).join('')}
          <div class="nav-label">Gerenciar</div>
          ${manage.map(link).join('')}
        </nav>
        <div class="side-foot">
          <div class="who">${esc(state.user.name)}</div>
          <div class="out" id="logout">Sair da conta</div>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <h1 id="pageTitle">Início</h1>
          <select class="veh-select" id="vehSelect">
            <option value="0">Todos os veículos</option>
            ${state.vehicles.map((v) =>
              `<option value="${v.id}" ${v.id === state.vehicleId ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
          </select>
        </header>
        <main class="content" id="content">${contentHTML}</main>
      </div>
    </div>
    <nav class="bottomnav">
      <a href="#/history" class="${active === 'history' ? 'active' : ''}"><span class="ico">🕘</span>Histórico</a>
      <a href="#/reports" class="${active === 'reports' ? 'active' : ''}"><span class="ico">📊</span>Relatórios</a>
      <a href="#/novo" class="fab-slot"><span class="fab">+</span></a>
      <a href="#/reminders" class="${active === 'reminders' ? 'active' : ''}"><span class="ico">🔔</span>Lembretes</a>
      <a href="#/settings" class="${active === 'settings' || active === 'account' || active === 'vehicles' ? 'active' : ''}"><span class="ico">☰</span>Mais</a>
    </nav>`;

  $('#logout').onclick = async () => {
    await api('/api/logout', { method: 'POST' });
    state.user = null;
    state.cache = {};
    renderAuth();
  };

  $('#vehSelect').onchange = (e) => {
    state.vehicleId = Number(e.target.value);
    localStorage.setItem('vehicleId', String(state.vehicleId));
    router();
  };
}

function setTitle(t) {
  const el = $('#pageTitle');
  if (el) el.textContent = t;
  document.title = `${t} · Carango`;
}

/* ---------- router ------------------------------------------------------- */
const views = {};
function router() {
  if (!state.user) return renderAuth();
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [page, param] = hash.split('/');
  const view = views[page] || views.dashboard;
  view(param);
}

window.addEventListener('hashchange', router);

/* ==========================================================================
   VIEW · dashboard
   ========================================================================== */
views.dashboard = async function () {
  shell('<div class="empty">Carregando…</div>', 'dashboard');
  setTitle('Início');
  const qs = state.vehicleId ? `?vehicle_id=${state.vehicleId}` : '';
  const [d, vehicles] = await Promise.all([api(`/api/dashboard${qs}`), loadVehicles()]);
  const v = state.vehicles.find((x) => x.id === state.vehicleId);

  const cards = [
    { c: '#0097a7', lbl: 'Odômetro', val: d.odometer != null ? `${fmtNum(d.odometer, 0)} km` : '—', sub: v ? esc(v.name) : 'último registro' },
    { c: '#ff9800', lbl: 'Eficiência média', val: d.efficiency.average ? `${fmtNum(d.efficiency.average, 1)} km/L` : '—',
      sub: d.efficiency.average ? `R$ ${fmtNum(d.efficiency.costPerKm, 3)}/km` : 'registre 2 tanques cheios' },
    { c: '#e64a19', lbl: 'Gastos totais', val: fmtMoney(d.totals.expenses + d.totals.services + d.totals.fuel),
      sub: `Despesas + serviços + combustível` },
    { c: '#2e7d32', lbl: 'Saldo', val: fmtMoney(d.totals.balance), sub: 'Receitas − gastos' },
  ];

  const quick = [
    { k: 'refueling', t: 'Abastecimento', i: '⛽', c: '#ff9800', s: '#fff3e0' },
    { k: 'expense',   t: 'Despesa',       i: '💸', c: '#e64a19', s: '#fbe9e7' },
    { k: 'service',   t: 'Serviço',       i: '🔧', c: '#795548', s: '#efebe9' },
    { k: 'income',    t: 'Receita',       i: '💰', c: '#2e7d32', s: '#e8f5e9' },
    { k: 'route',     t: 'Percurso',      i: '🛣️', c: '#607d8b', s: '#eceff1' },
    { k: 'reading',   t: 'Leitura',       i: '📍', c: '#c2185b', s: '#fce4ec' },
    { k: 'reminder',  t: 'Lembrete',      i: '🔔', c: '#673ab7', s: '#ede7f6' },
    { k: 'vehicle',   t: 'Veículo',       i: '🚗', c: '#0097a7', s: '#e0f7fa' },
  ];

  $('#content').innerHTML = `
    <div class="grid grid-4" style="margin-bottom:18px">
      ${cards.map((c) => `
        <div class="stat" style="--c:${c.c}">
          <div class="lbl"><span class="dot"></span>${c.lbl}</div>
          <div class="val">${c.val}</div>
          <div class="sub">${c.sub}</div>
        </div>`).join('')}
    </div>

    <div class="card">
      <div class="card-head"><h2>Ações rápidas</h2></div>
      <div class="quick-actions">
        ${quick.map((q) => `
          <button class="qa" data-new="${q.k}" style="--c:${q.c};--c-soft:${q.s}">
            <span class="qa-ico">${q.i}</span>${q.t}
          </button>`).join('')}
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><h2>Resumo</h2><span class="hint">todos os períodos</span></div>
        <dl class="kv">
          <dt>Abastecimentos</dt><dd>${d.counts.refuelings} · ${fmtMoney(d.totals.fuel)}</dd>
          <dt>Combustível abastecido</dt><dd>${fmtNum(d.totals.volume, 1)} L</dd>
          <dt>Despesas</dt><dd>${d.counts.expenses} · ${fmtMoney(d.totals.expenses)}</dd>
          <dt>Serviços</dt><dd>${d.counts.services} · ${fmtMoney(d.totals.services)}</dd>
          <dt>Receitas</dt><dd>${d.counts.incomes} · ${fmtMoney(d.totals.incomes)}</dd>
          <dt>Distância em percursos</dt><dd>${fmtNum(d.totals.km, 0)} km</dd>
        </dl>
      </div>

      <div class="card">
        <div class="card-head"><h2>Próximos lembretes</h2><a href="#/reminders" class="hint">ver todos</a></div>
        ${d.reminders.length ? d.reminders.map(reminderRow).join('') : `
          <div class="empty" style="padding:26px 10px">
            <div class="big">🔔</div>
            <p>Nenhum lembrete próximo.</p>
            <button class="btn sm" data-new="reminder">Criar lembrete</button>
          </div>`}
      </div>
    </div>`;

  $$('#content [data-new]').forEach((b) => (b.onclick = () => openNew(b.dataset.new)));
};

function reminderRow(r) {
  const isOdo = r.kind === 'odometer';
  const due = isOdo ? `${fmtNum(r.due_odometer, 0)} km` : fmtDate(r.due_date);
  const overdue = isOdo
    ? false
    : r.due_date && r.due_date < new Date().toISOString().slice(0, 10);
  return `
    <div class="reminder-item">
      <div class="ri-ico">${isOdo ? '📍' : '📅'}</div>
      <div class="ri-body">
        <div class="ri-title">${esc(r.title)}</div>
        <div class="ri-sub">${esc(r.vehicle_name || '')}${r.repeat_days ? ` · repete a cada ${r.repeat_days} dias` : ''}${r.repeat_km ? ` · a cada ${fmtNum(r.repeat_km, 0)} km` : ''}</div>
      </div>
      <div class="ri-val" style="color:${overdue ? '#d50000' : '#673ab7'}">${overdue ? 'vencido · ' : ''}${due}</div>
    </div>`;
}

/* ==========================================================================
   VIEW · history
   ========================================================================== */
views.history = async function () {
  shell('<div class="empty">Carregando…</div>', 'history');
  setTitle('Histórico');

  $('#content').innerHTML = `
    <div class="page-title">
      <div><h2>Histórico</h2><p>Todos os registros do veículo em ordem cronológica</p></div>
      <button class="btn ghost" id="btnExport">⬇ Exportar CSV</button>
    </div>
    <div class="card">
      <div class="filters" style="margin-bottom:15px">
        <input class="search" id="hQ" placeholder="Buscar por serviço, despesa, tipo, posto…" />
        <input type="date" id="hFrom" title="De" />
        <input type="date" id="hTo" title="Até" />
        <select id="hType">
          <option value="">Todos os tipos</option>
          ${Object.entries(TYPE_META).filter(([k]) => k !== 'reminder').map(([k, m]) =>
            `<option value="${k}">${m.label}</option>`).join('')}
        </select>
        <button class="btn sm ghost" id="hClear">Limpar</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Data</th><th>Tipo</th><th>Descrição</th><th>Detalhe</th><th>Veículo</th><th class="num">Valor</th><th></th></tr></thead>
        <tbody id="hBody"><tr class="empty"><td colspan="7">Carregando…</td></tr></tbody>
      </table></div>
    </div>`;

  const load = async () => {
    const p = new URLSearchParams();
    const q = $('#hQ').value.trim(); if (q) p.set('q', q);
    const f = $('#hFrom').value; if (f) p.set('from', f);
    const t = $('#hTo').value; if (t) p.set('to', t);
    const ty = $('#hType').value; if (ty) p.set('types', ty);
    if (state.vehicleId) p.set('vehicle_id', state.vehicleId);
    const rows = await api(`/api/history?${p}`);
    const RES = { refueling:'refuelings', expense:'expenses', service:'services', income:'incomes', route:'routes', reading:'readings' };
    $('#hBody').innerHTML = rows.length
      ? rows.map((r) => {
          const m = TYPE_META[r.type];
          const val = r.type === 'reading' ? `${fmtNum(r.value, 0)} km`
            : r.type === 'route' ? (r.value != null ? `${fmtNum(r.value, 0)} km` : '—')
            : fmtMoney(r.value);
          const sign = r.type === 'income' ? '+' : ['expense', 'service', 'refueling'].includes(r.type) ? '−' : '';
          return `<tr>
            <td style="white-space:nowrap">${fmtDate(r.date)}</td>
            <td><span class="chip ${r.type}"><span class="d"></span>${m.label}</span></td>
            <td style="font-weight:600;color:var(--text-title)">${esc(r.title)}</td>
            <td style="color:var(--text-muted);font-size:12.5px">${esc(r.sub || '')}</td>
            <td>${esc(r.vehicle_name || '')}</td>
            <td class="num" style="font-weight:600;color:${r.type === 'income' ? '#2e7d32' : 'var(--text-title)'}">${sign}${val}</td>
            <td style="white-space:nowrap;text-align:right">
              <button class="btn sm ghost" data-hedit="${r.type}:${r.id}">Editar</button>
              <button class="btn sm ghost" data-hdel="${r.type}:${r.id}" style="color:#d50000">Excluir</button>
            </td>
          </tr>`;
        }).join('')
      : `<tr class="empty"><td colspan="7"><b>Nenhum registro encontrado</b><br>Ajuste os filtros ou registre um novo evento.</td></tr>`;

    $$('[data-hedit]').forEach((b) => (b.onclick = async () => {
      const [type, id] = b.dataset.hedit.split(':');
      try { const row = await api(`/api/${RES[type]}/${id}`); openEdit(type, row); }
      catch (e) { toast(e.message, 'err'); }
    }));
    $$('[data-hdel]').forEach((b) => (b.onclick = () => {
      const [type, id] = b.dataset.hdel.split(':');
      confirmDialog('Excluir este registro?', async () => {
        try { await api(`/api/${RES[type]}/${id}`, { method: 'DELETE' }); toast('Registro excluído.', 'ok'); load(); }
        catch (e) { toast(e.message, 'err'); }
      });
    }));
  };

  let t;
  const debounced = () => { clearTimeout(t); t = setTimeout(load, 260); };
  $('#hQ').oninput = debounced;
  $('#hFrom').onchange = load;
  $('#hTo').onchange = load;
  $('#hType').onchange = load;
  $('#hClear').onclick = () => { $('#hQ').value = ''; $('#hFrom').value = ''; $('#hTo').value = ''; $('#hType').value = ''; load(); };
  $('#btnExport').onclick = () => {
    const kind = $('#hType').value || 'refuelings';
    window.open(`/api/export.csv?kind=${kind}`, '_blank');
  };
  await load();
};

/* ==========================================================================
   VIEW · reports
   ========================================================================== */
views.reports = async function () {
  shell('<div class="empty">Carregando…</div>', 'reports');
  setTitle('Relatórios');

  $('#content').innerHTML = `
    <div class="page-title">
      <div><h2>Relatórios</h2><p>Análise de gastos, consumo e desempenho</p></div>
    </div>
    <div class="card">
      <div class="filters">
        <select id="rPeriod">
          <option value="5">Todo o período</option>
          <option value="7">Este mês</option>
          <option value="8">Mês passado</option>
          <option value="1">Último mês</option>
          <option value="2" selected>Últimos 3 meses</option>
          <option value="3">Últimos 6 meses</option>
          <option value="4">Últimos 12 meses</option>
        </select>
        <input type="date" id="rFrom" title="De" />
        <input type="date" id="rTo" title="Até" />
        <button class="btn sm" id="rApply">Aplicar filtro</button>
      </div>
    </div>

    <div class="grid grid-3" style="margin-bottom:18px">
      <div class="card"><div class="card-head"><h2>Gastos mensais</h2></div><div class="chart-box"><canvas id="cMonthly"></canvas></div></div>
      <div class="card"><div class="card-head"><h2>Receitas × despesas</h2></div><div class="chart-box"><canvas id="cBalance"></canvas></div></div>
      <div class="card"><div class="card-head"><h2>Preço do combustível</h2></div><div class="chart-box"><canvas id="cPrice"></canvas></div></div>
    </div>

    <div class="grid grid-2" style="margin-bottom:18px">
      <div class="card"><div class="card-head"><h2>Despesas por tipo</h2></div><div class="chart-box"><canvas id="cType"></canvas></div></div>
      <div class="card"><div class="card-head"><h2>Gastos por posto</h2></div><div class="chart-box"><canvas id="cStation"></canvas></div></div>
    </div>

    <div class="grid grid-2">
      <div class="card"><div class="card-head"><h2>Distância mensal</h2></div><div class="chart-box sm"><canvas id="cKm"></canvas></div></div>
      <div class="card"><div class="card-head"><h2>Eficiência por tanque cheio</h2><span class="hint">km/L</span></div><div class="chart-box sm"><canvas id="cEff"></canvas></div></div>
    </div>`;

  const charts = {};
  const palette = ['#0097a7', '#ff9800', '#e64a19', '#2e7d32', '#795548', '#607d8b', '#c2185b', '#673ab7', '#2196f3', '#8bc34a'];

  const load = async () => {
    const p = new URLSearchParams({ period: $('#rPeriod').value });
    if ($('#rFrom').value) p.set('from', $('#rFrom').value);
    if ($('#rTo').value) p.set('to', $('#rTo').value);
    if (state.vehicleId) p.set('vehicle_id', state.vehicleId);
    const d = await api(`/api/reports?${p}`);

    Object.values(charts).forEach((c) => c.destroy());
    Object.keys(charts).forEach((k) => delete charts[k]);
    const commonOpts = {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { grid: { display: false }, ticks: { font: { size: 11 }, maxRotation: 0, autoSkipPadding: 8 } },
                y: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 } }, beginAtZero: true } },
    };

    const ymLabel = (ym) => {
      const [y, m] = ym.split('-');
      return ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][Number(m) - 1] + '/' + y.slice(2);
    };

    // merge monthly series
    const yms = [...new Set([...d.monthly.map(x => x.ym), ...d.monthlyFuel.map(x => x.ym), ...d.monthlyIncome.map(x => x.ym)])].sort();
    const map = (arr) => Object.fromEntries(arr.map((x) => [x.ym, x]));
    const M = map(d.monthly), F = map(d.monthlyFuel), I = map(d.monthlyIncome), S = map(d.monthlyServices);

    charts.monthly = new Chart($('#cMonthly'), {
      type: 'bar',
      data: {
        labels: yms.map(ymLabel),
        datasets: [
          { label: 'Despesas', data: yms.map((y) => M[y]?.expenses || 0), backgroundColor: '#e64a19', borderRadius: 4 },
          { label: 'Combustível', data: yms.map((y) => F[y]?.v || 0), backgroundColor: '#ff9800', borderRadius: 4 },
          { label: 'Serviços', data: yms.map((y) => S[y]?.v || 0), backgroundColor: '#795548', borderRadius: 4 },
        ],
      },
      options: { ...commonOpts, plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: { ...commonOpts.scales, x: { ...commonOpts.scales.x, stacked: true }, y: { ...commonOpts.scales.y, stacked: true } } },
    });

    charts.balance = new Chart($('#cBalance'), {
      type: 'line',
      data: {
        labels: yms.map(ymLabel),
        datasets: [
          { label: 'Receitas', data: yms.map((y) => I[y]?.v || 0), borderColor: '#2e7d32', backgroundColor: 'rgba(46,125,50,.12)', fill: true, tension: .35, pointRadius: 3 },
          { label: 'Gastos', data: yms.map((y) => (M[y]?.expenses || 0) + (F[y]?.v || 0) + (S[y]?.v || 0)), borderColor: '#e64a19', backgroundColor: 'rgba(230,74,25,.10)', fill: true, tension: .35, pointRadius: 3 },
        ],
      },
      options: { ...commonOpts, plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } } },
    });

    const ph = d.priceHistory || [];
    charts.price = new Chart($('#cPrice'), {
      type: 'line',
      data: {
        labels: ph.map((r) => fmtDate(r.date)),
        datasets: [{
          label: 'R$/L', data: ph.map((r) => r.price),
          borderColor: '#ff9800', backgroundColor: 'rgba(255,152,0,.14)',
          fill: true, tension: .3, pointRadius: ph.length > 40 ? 0 : 3, borderWidth: 2,
        }],
      },
      options: commonOpts,
    });

    const pie = (canvasId, rows, colorStart) => new Chart($(canvasId), {
      type: 'doughnut',
      data: {
        labels: rows.map((r) => r.name),
        datasets: [{ data: rows.map((r) => r.value),
          backgroundColor: rows.map((_, i) => palette[(colorStart + i) % palette.length]), borderWidth: 2, borderColor: '#fff' }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '58%',
        plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11.5 }, padding: 9 } } },
      },
    });
    charts.type = pie('#cType', d.byType || [], 2);
    charts.station = pie('#cStation', d.byStation || [], 0);

    const kmYm = [...new Set([...d.monthlyKm.map(x => x.ym), ...yms])].sort();
    const KM = map(d.monthlyKm);
    charts.km = new Chart($('#cKm'), {
      type: 'bar',
      data: { labels: kmYm.map(ymLabel), datasets: [{ label: 'km', data: kmYm.map((y) => KM[y]?.km || 0), backgroundColor: '#607d8b', borderRadius: 4 }] },
      options: commonOpts,
    });

    const eff = d.efficiency || [];
    charts.eff = new Chart($('#cEff'), {
      type: 'line',
      data: {
        labels: eff.map((r) => fmtDate(r.date)),
        datasets: [{
          label: 'km/L', data: eff.map((r) => r.kmPerL),
          borderColor: '#0097a7', backgroundColor: 'rgba(0,151,167,.14)', fill: true, tension: .3, pointRadius: 3, borderWidth: 2,
        }],
      },
      options: { ...commonOpts, plugins: { legend: { display: false } } },
    });
  };

  $('#rApply').onclick = load;
  $('#rPeriod').onchange = load;
  await load();
};

/* ==========================================================================
   VIEW · reminders
   ========================================================================== */
views.reminders = async function () {
  shell('<div class="empty">Carregando…</div>', 'reminders');
  setTitle('Lembretes');
  const rows = await api('/api/reminders');

  $('#content').innerHTML = `
    <div class="page-title">
      <div><h2>Lembretes</h2><p>Manutenção, revisões e vencimentos por data ou odômetro</p></div>
      <button class="btn" id="btnNew">+ Novo lembrete</button>
    </div>
    <div class="card">
      ${rows.length ? `<table>
        <thead><tr><th></th><th>Título</th><th>Veículo</th><th>Dispara em</th><th>Repetição</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((r) => {
          const isOdo = r.kind === 'odometer';
          const due = isOdo ? `${fmtNum(r.due_odometer, 0)} km` : fmtDate(r.due_date);
          const rep = r.repeat_days ? `a cada ${r.repeat_days} dias` : r.repeat_km ? `a cada ${fmtNum(r.repeat_km, 0)} km` : '—';
          return `<tr>
            <td style="width:36px;font-size:17px">${isOdo ? '📍' : '📅'}</td>
            <td style="font-weight:600;color:var(--text-title)">${esc(r.title)}</td>
            <td>${esc(r.vehicle_name)}</td>
            <td style="color:var(--lembrete);font-weight:600">${due}</td>
            <td style="color:var(--text-muted)">${rep}</td>
            <td><span class="chip" style="${r.active ? 'background:#e8f5e9;color:#1b5e20' : ''}">${r.active ? 'Ativo' : 'Pausado'}</span></td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn sm ghost" data-edit="${r.id}">Editar</button>
              <button class="btn sm ghost" data-del="${r.id}" style="color:#d50000">Excluir</button>
            </td>
          </tr>`;
        }).join('')}</tbody></table>`
      : `<div class="empty"><div class="big">🔔</div><h3>Nenhum lembrete</h3>
           <p>Não esqueça da troca de óleo, do seguro ou da revisão.</p>
           <button class="btn" id="btnNew2">Criar lembrete</button></div>`}
    </div>`;

  const open = () => openNew('reminder');
  $('#btnNew').onclick = open;
  const b2 = $('#btnNew2'); if (b2) b2.onclick = open;

  $$('[data-edit]').forEach((b) => (b.onclick = () => openEdit('reminder', rows.find((r) => r.id === Number(b.dataset.edit)))));
  $$('[data-del]').forEach((b) => (b.onclick = () =>
    confirmDialog('Deseja realmente excluir este lembrete?', async () => {
      await api(`/api/reminders/${b.dataset.del}`, { method: 'DELETE' });
      toast('Excluído com sucesso!', 'ok');
      views.reminders();
    })));
};

/* ==========================================================================
   VIEW · vehicles
   ========================================================================== */
views.vehicles = async function () {
  shell('<div class="empty">Carregando…</div>', 'vehicles');
  setTitle('Veículos');
  const rows = await api('/api/vehicles');

  $('#content').innerHTML = `
    <div class="page-title">
      <div><h2>Veículos</h2><p>Cadastre e configure seus veículos</p></div>
      <button class="btn" id="btnNew">+ Novo veículo</button>
    </div>
    ${rows.length ? `<div class="grid grid-3">${rows.map((v) => `
      <div class="card" style="margin:0">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
          <div>
            <div style="font-size:19px;font-weight:700;color:var(--text-title)">${esc(v.name)}</div>
            <div style="font-size:13px;color:var(--text-muted);margin-top:2px">${esc(v.brand || '')} ${esc(v.model || '')} · ${v.year || '—'}</div>
          </div>
          <span class="chip" style="background:#e0f7fa;color:#00838f">${esc(v.plate || 'S/ placa')}</span>
        </div>
        <dl class="kv" style="margin-top:15px">
          <dt>Combustível</dt><dd>${esc(v.fuel_type)}</dd>
          <dt>Tanque</dt><dd>${fmtNum(v.tank_volume, 0)} L</dd>
          <dt>Unidade</dt><dd>${v.odometer_unit === 1 ? 'km' : 'mi'}</dd>
        </dl>
        <div style="display:flex;gap:7px;margin-top:15px">
          <button class="btn sm ghost" data-edit="${v.id}" style="flex:1">Editar</button>
          <button class="btn sm ghost" data-del="${v.id}" style="flex:1;color:#d50000">Excluir</button>
        </div>
      </div>`).join('')}</div>`
    : `<div class="card"><div class="empty"><div class="big">🚗</div><h3>Nenhum veículo</h3>
        <p>Cadastre seu primeiro veículo para começar a controlar.</p>
        <button class="btn" id="btnNew2">Cadastrar veículo</button></div></div>`}`;

  const open = () => openNew('vehicle');
  $('#btnNew').onclick = open;
  const b2 = $('#btnNew2'); if (b2) b2.onclick = open;
  $$('[data-edit]').forEach((b) => (b.onclick = () => openEdit('vehicle', rows.find((v) => v.id === Number(b.dataset.edit)))));
  $$('[data-del]').forEach((b) => (b.onclick = () =>
    confirmDialog('Excluir o veículo também apaga todos os registros vinculados a ele. Deseja continuar?', async () => {
      await api(`/api/vehicles/${b.dataset.del}`, { method: 'DELETE' });
      toast('Veículo excluído.', 'ok');
      state.vehicles = await api('/api/vehicles');
      if (!state.vehicles.some((v) => v.id === state.vehicleId)) {
        state.vehicleId = 0; localStorage.setItem('vehicleId', '0');
      }
      views.vehicles();
    })));
};

/* ==========================================================================
   VIEW · settings (cadastros)
   ========================================================================== */
const LOOKUPS = [
  { k: 'fuels',           t: 'Combustíveis',      i: '⛽' },
  { k: 'stations',        t: 'Postos',            i: '🏪' },
  { k: 'places',          t: 'Locais',            i: '📍' },
  { k: 'payment_methods', t: 'Formas de pagamento', i: '💳' },
  { k: 'expense_types',   t: 'Tipos de despesa',  i: '💸' },
  { k: 'service_types',   t: 'Tipos de serviço',  i: '🔧' },
  { k: 'income_types',    t: 'Tipos de receita',  i: '💰' },
  { k: 'reason_types',    t: 'Motivos',           i: '🎯' },
  { k: 'drivers',         t: 'Motoristas',        i: '🧑‍✈️' },
];

views.settings = async function (param) {
  const active = param && LOOKUPS.some((l) => l.k === param) ? param : LOOKUPS[0].k;
  shell('<div class="empty">Carregando…</div>', 'settings');
  setTitle('Cadastros');

  const meta = LOOKUPS.find((l) => l.k === active);
  $('#content').innerHTML = `
    <div class="page-title">
      <div><h2>Cadastros</h2><p>Listas de apoio usadas nos formulários</p></div>
    </div>
    <div class="tabs">
      ${LOOKUPS.map((l) => `<button data-tab="${l.k}" class="${l.k === active ? 'on' : ''}">${l.i} ${l.t}</button>`).join('')}
    </div>
    <div class="card" id="lookupBox"><div class="empty">Carregando…</div></div>`;

  $$('[data-tab]').forEach((b) => (b.onclick = () => (location.hash = `#/settings/${b.dataset.tab}`)));

  const rows = await api(`/api/${active}`);
  const hasAddress = ['stations', 'places'].includes(active);
  $('#lookupBox').innerHTML = `
    <div class="card-head">
      <h2>${meta.i} ${meta.t}</h2>
      <button class="btn sm" id="btnAdd">+ Adicionar</button>
    </div>
    ${rows.length ? `<table>
      <thead><tr><th>Nome</th>${hasAddress ? '<th>Endereço</th>' : ''}<th>Status</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td style="font-weight:600;color:var(--text-title)">${esc(r.name)}</td>
        ${hasAddress ? `<td style="color:var(--text-muted)">${esc(r.address || '—')}</td>` : ''}
        <td><span class="chip" style="${r.active ? 'background:#e8f5e9;color:#1b5e20' : ''}">${r.active ? 'Ativo' : 'Inativo'}</span></td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn sm ghost" data-edit="${r.id}">Editar</button>
          <button class="btn sm ghost" data-del="${r.id}" style="color:#d50000">Excluir</button>
        </td></tr>`).join('')}</tbody></table>`
    : `<div class="empty"><div class="big">${meta.i}</div><h3>Nenhum item</h3>
        <p>Adicione o primeiro ${esc(meta.t.toLowerCase().replace(/s$/, ''))}.</p>
        <button class="btn" id="btnAdd2">Adicionar</button></div>`}`;

  const open = () => modal(`Novo · ${meta.t}`, `
    <div class="form-grid">
      ${field('name', 'Nome', input('name', 'required placeholder="Nome"'), { req: true, full: true })}
      ${hasAddress ? field('address', 'Endereço', input('address', 'placeholder="Rua, número, bairro"'), { full: true }) : ''}
      ${field('active', 'Ativo', `<select id="__ID__" name="active"><option value="1">Sim</option><option value="0">Não</option></select>`, { full: true })}
    </div>`, async (body) => {
    await api(`/api/${active}`, { method: 'POST', body });
    toast('Adicionado com sucesso!', 'ok');
    views.settings(active);
  });

  $('#btnAdd').onclick = open;
  const b2 = $('#btnAdd2'); if (b2) b2.onclick = open;

  $$('[data-edit]').forEach((b) => (b.onclick = () => {
    const r = rows.find((x) => x.id === Number(b.dataset.edit));
    modal(`Editar · ${meta.t}`, `
      <div class="form-grid">
        ${field('name', 'Nome', input('name', 'required', ).replace('__ID__', 'f_name'), { req: true, full: true }).replace(`value="${esc(r.name)}"`, `value="${esc(r.name)}"`)}
        ${hasAddress ? field('address', 'Endereço', `<input id="f_address" name="address" value="${esc(r.address || '')}">`, { full: true }) : ''}
        ${field('active', 'Ativo', `<select id="f_active" name="active"><option value="1" ${r.active ? 'selected' : ''}>Sim</option><option value="0" ${!r.active ? 'selected' : ''}>Não</option></select>`, { full: true })}
      </div>`, async (body) => {
      await api(`/api/${active}/${r.id}`, { method: 'PUT', body });
      toast('Atualizado com sucesso!', 'ok');
      views.settings(active);
    });
  }));

  $$('[data-del]').forEach((b) => (b.onclick = () =>
    confirmDialog(`Deseja realmente excluir "${rows.find((x) => x.id === Number(b.dataset.del))?.name}"?`, async () => {
      await api(`/api/${active}/${b.dataset.del}`, { method: 'DELETE' });
      toast('Excluído com sucesso!', 'ok');
      views.settings(active);
    })));
};

/* ==========================================================================
   VIEW · account / configurações
   ========================================================================== */
views.account = async function () {
  shell('<div class="empty">Carregando…</div>', 'account');
  setTitle('Configurações');
  let qt = { token: '' };
  try { qt = await api('/api/quick-token'); } catch {}
  const quickUrl = `${location.origin}/quick.html?token=${encodeURIComponent(qt.token)}`;

  $('#content').innerHTML = `
    <div class="page-title"><div><h2>Configurações</h2><p>Sua conta e preferências</p></div></div>

    <div class="card">
      <div class="card-head"><h2>Conta</h2></div>
      <div class="settings-row">
        <div class="sr-body">
          <div class="sr-title">${esc(state.user.name)}</div>
          <div class="sr-sub">${esc(state.user.email)}</div>
        </div>
      </div>
      <div class="settings-row">
        <div class="sr-body">
          <div class="sr-title">Sair da conta</div>
          <div class="sr-sub">Encerra a sessão neste dispositivo</div>
        </div>
        <button class="btn ghost sm" id="accLogout">Sair</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Abastecimento rápido</h2></div>
      <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:10px">
        <div class="sr-body">
          <div class="sr-title">Link rápido (celular)</div>
          <div class="sr-sub">Abra no celular e adicione à tela inicial para registrar abastecimentos direto no posto. O link inclui seu token de acesso rápido.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input id="quickUrl" readonly value="${esc(quickUrl)}" style="flex:1;min-width:220px;padding:10px 12px;border:1px solid var(--divisor);border-radius:9px;font-size:13px;background:#f7fafb">
          <button class="btn sm" id="btnCopyQuick">Copiar link</button>
          <a class="btn sm ghost" href="${esc(quickUrl)}" target="_blank" rel="noopener">Abrir</a>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
          <button class="btn sm ghost" id="btnRegenQuick">Regenerar token</button>
          <span class="sr-sub">Regenerar invalida o link anterior.</span>
        </div>
        <div class="sr-sub" style="margin-top:6px;line-height:1.5">
          <b>API:</b> <code>POST /api/quick/refueling?token=SEU_TOKEN</code> com JSON <code>{vehicle_id, date, odometer, volume, price, total, full_tank}</code>. Também útil para atalhos iOS/Android, Tasker ou webhooks (ex.: bot de WhatsApp via Twilio/Meta).
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Dados</h2></div>
      <div class="settings-row">
        <div class="sr-body">
          <div class="sr-title">Exportar dados (CSV)</div>
          <div class="sr-sub">Planilha compatível com Excel e LibreOffice</div>
        </div>
        <select id="expKind" style="padding:8px 10px;border:1px solid var(--divisor);border-radius:9px;font-size:13.5px">
          <option value="refuelings">Abastecimentos</option>
          <option value="expenses">Despesas</option>
          <option value="services">Serviços</option>
          <option value="incomes">Receitas</option>
          <option value="routes">Percursos</option>
          <option value="readings">Leituras</option>
        </select>
        <button class="btn sm" id="btnExp">⬇ Exportar</button>
      </div>
      <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:10px">
        <div class="sr-body">
          <div class="sr-title">Importar dados (CSV)</div>
          <div class="sr-sub">Selecione o tipo, baixe o modelo e importe. Separador <code>,</code> ou <code>;</code>. Data <code>DD/MM/AAAA</code> ou <code>YYYY-MM-DD</code>.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <select id="impKind" style="padding:8px 10px;border:1px solid var(--divisor);border-radius:9px;font-size:13.5px">
            <option value="refuelings">Abastecimentos</option>
            <option value="expenses">Despesas</option>
            <option value="services">Serviços</option>
            <option value="incomes">Receitas</option>
            <option value="routes">Percursos</option>
            <option value="readings">Leituras</option>
          </select>
          <select id="impVehicle" style="padding:8px 10px;border:1px solid var(--divisor);border-radius:9px;font-size:13.5px">${state.vehicles.map(v=>`<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select>
        </div>
        <div style="font-size:12.5px;background:#f7fafb;border:1px solid var(--divisor);border-radius:9px;padding:10px 12px;overflow:auto">
          <div style="font-weight:600;margin-bottom:4px;color:#37474f">Modelo</div>
          <code id="impModel" style="white-space:pre;display:block"></code>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="file" id="impFile" accept=".csv,text/csv" style="font-size:13px">
          <button class="btn sm ghost" id="btnImpTpl">Baixar modelo</button>
          <button class="btn sm" id="btnImp">Importar</button>
        </div>
        <div id="impStatus" class="sr-sub"></div>
      </div>
      <div class="settings-row">
        <div class="sr-body">
          <div class="sr-title">Dados de demonstração</div>
          <div class="sr-sub">${state.vehicles.length} veículo(s) · registros de exemplo já inseridos</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Sobre</h2></div>
      <div class="settings-row">
        <div class="sr-body">
          <div class="sr-title">Carango Web</div>
          <div class="sr-sub">Recriação web fiel do Carango 1.0.0 (br.com.ctncardoso.ctncar), analisado por engenharia reversa do APK.</div>
        </div>
      </div>
      <div class="settings-row">
        <div class="sr-body">
          <div class="sr-title">Recursos</div>
          <div class="sr-sub">Abastecimentos, despesas, serviços, receitas, percursos, leituras, lembretes, relatórios, exportação CSV e abastecimento rápido.</div>
        </div>
      </div>
    </div>`;

  $('#accLogout').onclick = async () => {
    await api('/api/logout', { method: 'POST' });
    state.user = null;
    renderAuth();
  };
  $('#btnExp').onclick = () => window.open(`/api/export.csv?kind=${$('#expKind').value}`, '_blank');
  $('#btnCopyQuick').onclick = async () => {
    const url = $('#quickUrl').value;
    try { await navigator.clipboard.writeText(url); toast('Link copiado.', 'ok'); }
    catch { $('#quickUrl').select(); document.execCommand('copy'); toast('Link copiado.', 'ok'); }
  };
  $('#btnRegenQuick').onclick = async () => {
    if (!confirm('Regenerar o token? O link anterior deixará de funcionar.')) return;
    const r = await api('/api/quick-token', { method: 'POST' });
    $('#quickUrl').value = `${location.origin}/quick.html?token=${encodeURIComponent(r.token)}`;
    $('#quickUrl').closest('.settings-row').querySelector('a.btn').href = $('#quickUrl').value;
    toast('Token regenerado.', 'ok');
  };

  const IMP_MODELS = {
    refuelings: 'data,odometro,volume,preco,total,tanque_cheio,combustivel,posto,observacao\n22/11/2026,61200,40.500,5.890,238.55,sim,Gasolina Comum,Shell Centro,viagem\n',
    expenses:   'data,titulo,valor,tipo,pagamento,local,odometro,observacao\n22/11/2026,Pedágio,35.00,Pedágio,Dinheiro,Rodovia,61200,viagem\n',
    services:   'data,titulo,valor,tipo,pagamento,local,odometro,observacao\n22/11/2026,Troca de óleo,280.00,Troca de óleo,Cartão,Oficina,61200,filtro incluído\n',
    incomes:    'data,valor,tipo,odometro,observacao\n22/11/2026,500.00,Frete,61200,serviço extra\n',
    routes:     'start_date,origem,destino,odometro_inicial,odometro_final,valor_km,frete,observacao\n22/11/2026,Casa,Trabalho,61000,61025,1.20,30.00,ida\n',
    readings:   'data,odometro,observacao\n22/11/2026,61200,leitura painel\n',
  };
  const setImpModel = () => { $('#impModel').textContent = IMP_MODELS[$('#impKind').value] || ''; };
  $('#impKind').onchange = setImpModel;
  setImpModel();

  $('#btnImpTpl').onclick = () => {
    const kind = $('#impKind').value;
    const blob = new Blob([IMP_MODELS[kind] || ''], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `modelo-${kind}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  $('#btnImp').onclick = async () => {
    const file = $('#impFile').files[0];
    if (!file) return toast('Selecione um arquivo CSV.', 'err');
    const kind = $('#impKind').value;
    const status = $('#impStatus');
    status.textContent = 'Lendo arquivo…';
    const text = await file.text();
    const parseCSV = (src) => {
      const lines = src.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').filter(l => l.trim());
      if (!lines.length) return [];
      const sep = (lines[0].match(/;/g)||[]).length >= (lines[0].match(/,/g)||[]).length ? ';' : ',';
      const split = (line) => {
        const out=[]; let cur=''; let q=false;
        for (let i=0;i<line.length;i++) {
          const c=line[i];
          if (c === '"') { if (q && line[i+1] === '"') { cur+='"'; i++; } else q=!q; }
          else if (c === sep && !q) { out.push(cur); cur=''; }
          else cur += c;
        }
        out.push(cur); return out.map(s=>s.trim());
      };
      const headers = split(lines[0]).map(h => h.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9_ ]/g,'').replace(/\s+/g,'_'));
      return lines.slice(1).map(line => { const cols = split(line); const obj={}; headers.forEach((h,i)=>obj[h]=cols[i]??''); return obj; });
    };
    try {
      const rows = parseCSV(text);
      if (!rows.length) { status.textContent = 'Nenhuma linha encontrada.'; return; }
      status.textContent = `Enviando ${rows.length} linha(s)…`;
      const r = await api(`/api/import/${kind}`, { method:'POST', body: { vehicle_id: Number($('#impVehicle').value), rows } });
      status.textContent = `Importados: ${r.imported}. ${r.errors?.length ? 'Erros: ' + r.errors.join(' | ') : ''}`;
      toast(`Importação concluída: ${r.imported} registro(s).`, 'ok');
      router();
    } catch (e) { status.textContent = e.message; toast(e.message, 'err'); }
  };
};

/* ==========================================================================
   FORMS · new / edit records
   ========================================================================== */
async function loadVehicles() {
  if (state.vehicles.length) return state.vehicles;
  state.vehicles = await api('/api/vehicles');
  return state.vehicles;
}

async function loadLookups() {
  const keys = ['fuels', 'stations', 'places', 'payment_methods', 'expense_types', 'service_types', 'income_types', 'reason_types', 'drivers'];
  const out = {};
  await Promise.all(keys.map(async (k) => { out[k] = await api(`/api/${k}`); }));
  return out;
}

const vehOpts = () => state.vehicles.map((v) => ({ v: v.id, t: v.name }));

function requireVehicle() {
  if (!state.vehicles.length) {
    toast('Cadastre um veículo primeiro.', 'err');
    location.hash = '#/vehicles';
    return false;
  }
  return true;
}

async function openNew(kind, preset = {}) {
  if (kind === 'vehicle') return openVehicleForm(null);
  if (!requireVehicle()) return;
  const L = await loadLookups();
  const vid = state.vehicleId || state.vehicles[0].id;
  const today = new Date().toISOString().slice(0, 10);

  const defs = {
    refueling: {
      title: 'Novo abastecimento', color: '#ff9800',
      body: () => `
        <div class="form-grid">
          ${field('vehicle_id', 'Veículo', select('vehicle_id', vehOpts()), { req: true })}
          ${field('date', 'Data', `<input id="f_date" name="date" type="date" value="${today}" required>`, { req: true })}
          <div class="field">
            <label for="f_odometer">Odômetro (km) <span class="req">*</span> <span class="muted" id="odo-last" style="font-weight:400"></span></label>
            <input id="f_odometer" name="odometer" type="number" step="0.1" min="0" required data-type="number">
            <div class="help">Leitura atual do painel</div>
          </div>
          ${field('volume', 'Volume (L)', `<input id="f_volume" name="volume" type="number" step="0.001" min="0" data-type="number">`, { help: 'Preenchido automaticamente se informar preço e total' })}
          ${field('price', 'Preço por litro (R$)', `<input id="f_price" name="price" type="number" step="0.001" min="0" data-type="number">`, { help: 'Preenchido automaticamente se informar volume e total' })}
          ${field('total', 'Valor total (R$)', `<input id="f_total" name="total" type="number" step="0.01" min="0" data-type="number">`, { help: 'Preenchido automaticamente se informar volume e preço' })}
          ${field('fuel_id', 'Combustível', select('fuel_id', [{ v: '', t: '—' }, ...opt(L.fuels)]))}
          ${field('station_id', 'Posto', select('station_id', [{ v: '', t: '—' }, ...opt(L.stations)]))}
          ${field('payment_id', 'Forma de pagamento', select('payment_id', [{ v: '', t: '—' }, ...opt(L.payment_methods)]))}
          ${field('driver_id', 'Motorista', select('driver_id', [{ v: '', t: '—' }, ...opt(L.drivers)]))}
          ${field('reason_id', 'Motivo', select('reason_id', [{ v: '', t: '—' }, ...opt(L.reason_types)]))}
          ${field('discount', 'Desconto (R$)', `<input id="f_discount" name="discount" type="number" step="0.01" min="0" value="0" data-type="number">`)}
          <div class="field full check" style="padding-top:0">
            <input type="checkbox" id="f_full_tank" name="full_tank" value="1" />
            <label for="f_full_tank" style="margin:0;font-weight:600">Tanque cheio <span style="font-weight:400;color:var(--text-muted)">— usado no cálculo da eficiência</span></label>
          </div>
          ${field('notes', 'Observação', `<textarea id="f_notes" name="notes" placeholder="Opcional"></textarea>`, { full: true })}
        </div>`,
      before: (b) => {
        const v = b.volume != null ? Number(b.volume) : NaN;
        const p = b.price  != null ? Number(b.price)  : NaN;
        const t = b.total  != null ? Number(b.total)  : NaN;
        if (!Number.isFinite(b.total)  && Number.isFinite(v) && Number.isFinite(p) && v > 0 && p > 0) b.total  = Number((v * p).toFixed(2));
        if (!Number.isFinite(b.volume) && Number.isFinite(t) && Number.isFinite(p) && t > 0 && p > 0) b.volume = Number((t / p).toFixed(3));
        if (!Number.isFinite(b.price)  && Number.isFinite(t) && Number.isFinite(v) && t > 0 && v > 0) b.price  = Number((t / v).toFixed(3));
        if (!Number.isFinite(Number(b.total)))  b.total = 0;
        if (!Number.isFinite(Number(b.volume))) b.volume = 0;
        if (!Number.isFinite(Number(b.price)))  b.price = 0;
        b.total = Number(b.total); b.volume = Number(b.volume); b.price = Number(b.price);
        if (b.full_tank === undefined) b.full_tank = 0;
        return b;
      },
      onReady: (form) => {
        // default vehicle
        const vSel = form.elements['vehicle_id'];
        if (vSel && vid) vSel.value = String(vid);

        // last odometer hint
        const hint = form.querySelector('#odo-last');
        const updateOdo = async () => {
          const id = Number(vSel?.value || 0);
          if (!id) { if (hint) hint.textContent = ''; return; }
          try {
            const r = await api(`/api/last-odometer?vehicle_id=${id}`);
            hint.textContent = r.odometer != null ? `| Último: ${fmtNum(r.odometer, 0)}` : '| Último: —';
          } catch { if (hint) hint.textContent = ''; }
        };
        vSel?.addEventListener('change', updateOdo);
        updateOdo();

        // live auto-calc volume/price/total
        const vol = form.elements['volume'];
        const pri = form.elements['price'];
        const tot = form.elements['total'];
        const toNum = (el) => { const n = Number(el.value); return el.value !== '' && Number.isFinite(n) ? n : NaN; };
        const recalc = (src) => {
          const v = toNum(vol), p = toNum(pri), t = toNum(tot);
          if (src !== 'total'  && Number.isFinite(v) && v > 0 && Number.isFinite(p) && p > 0) tot.value = (v * p).toFixed(2);
          else if (src !== 'volume' && Number.isFinite(t) && t > 0 && Number.isFinite(p) && p > 0) vol.value = (t / p).toFixed(3);
          else if (src !== 'price'  && Number.isFinite(t) && t > 0 && Number.isFinite(v) && v > 0) pri.value = (t / v).toFixed(3);
        };
        vol?.addEventListener('input', () => recalc('volume'));
        pri?.addEventListener('input', () => recalc('price'));
        tot?.addEventListener('input', () => recalc('total'));
      },
      endpoint: '/api/refuelings',
    },
    expense: {
      title: 'Nova despesa', color: '#e64a19',
      body: () => `
        <div class="form-grid">
          ${field('vehicle_id', 'Veículo', select('vehicle_id', vehOpts()))}
          ${field('date', 'Data', `<input id="f_date" name="date" type="date" value="${today}" required>`)}
          ${field('title', 'Título', `<input id="f_title" name="title" required placeholder="Ex.: Estacionamento aeroporto">`, { req: true })}
          ${field('value', 'Valor (R$)', `<input id="f_value" name="value" type="number" step="0.01" min="0" data-type=number required>`, { req: true })}
          ${field('expense_type_id', 'Tipo de despesa', select('expense_type_id', [{ v: '', t: '—' }, ...opt(L.expense_types)]))}
          ${field('payment_id', 'Forma de pagamento', select('payment_id', [{ v: '', t: '—' }, ...opt(L.payment_methods)]))}
          ${field('place_id', 'Local', select('place_id', [{ v: '', t: '—' }, ...opt(L.places)]))}
          ${field('driver_id', 'Motorista', select('driver_id', [{ v: '', t: '—' }, ...opt(L.drivers)]))}
          ${odoField('odometer', 'Odômetro (km)')}
          ${field('installments', 'Parcelas', `<input id="f_installments" name="installments" type="number" min="1" value="1" data-type=number>`)}
          ${field('discount', 'Desconto (R$)', `<input id="f_discount" name="discount" type="number" step="0.01" min="0" value="0" data-type=number>`)}
          ${field('notes', 'Observação', `<textarea id="f_notes" name="notes"></textarea>`, { full: true })}
        </div>`,
      onReady: (form) => wireOdoHints(form),
      endpoint: '/api/expenses',
    },
    service: {
      title: 'Novo serviço', color: '#795548',
      body: () => `
        <div class="form-grid">
          ${field('vehicle_id', 'Veículo', select('vehicle_id', vehOpts()))}
          ${field('date', 'Data', `<input id="f_date" name="date" type="date" value="${today}" required>`)}
          ${field('title', 'Título', `<input id="f_title" name="title" required placeholder="Ex.: Troca de óleo e filtro">`, { req: true })}
          ${field('value', 'Valor (R$)', `<input id="f_value" name="value" type="number" step="0.01" min="0" data-type=number required>`, { req: true })}
          ${field('service_type_id', 'Tipo de serviço', select('service_type_id', [{ v: '', t: '—' }, ...opt(L.service_types)]))}
          ${field('payment_id', 'Forma de pagamento', select('payment_id', [{ v: '', t: '—' }, ...opt(L.payment_methods)]))}
          ${field('place_id', 'Local', select('place_id', [{ v: '', t: '—' }, ...opt(L.places)]))}
          ${field('driver_id', 'Motorista', select('driver_id', [{ v: '', t: '—' }, ...opt(L.drivers)]))}
          ${odoField('odometer', 'Odômetro (km)')}
          ${field('installments', 'Parcelas', `<input id="f_installments" name="installments" type="number" min="1" value="1" data-type=number>`)}
          ${field('discount', 'Desconto (R$)', `<input id="f_discount" name="discount" type="number" step="0.01" min="0" value="0" data-type=number>`)}
          ${field('notes', 'Observação', `<textarea id="f_notes" name="notes"></textarea>`, { full: true })}
        </div>`,
      onReady: (form) => wireOdoHints(form),
      endpoint: '/api/services',
    },
    income: {
      title: 'Nova receita', color: '#2e7d32',
      body: () => `
        <div class="form-grid">
          ${field('vehicle_id', 'Veículo', select('vehicle_id', vehOpts()))}
          ${field('date', 'Data', `<input id="f_date" name="date" type="date" value="${today}" required>`)}
          ${field('value', 'Valor (R$)', `<input id="f_value" name="value" type="number" step="0.01" min="0" data-type=number required>`, { req: true })}
          ${field('income_type_id', 'Tipo de receita', select('income_type_id', [{ v: '', t: '—' }, ...opt(L.income_types)]))}
          ${odoField('odometer', 'Odômetro (km)')}
          ${field('installments', 'Parcelas', `<input id="f_installments" name="installments" type="number" min="1" value="1" data-type=number>`)}
          ${field('notes', 'Observação', `<textarea id="f_notes" name="notes"></textarea>`, { full: true })}
        </div>`,
      onReady: (form) => wireOdoHints(form),
      endpoint: '/api/incomes',
    },
    route: {
      title: 'Novo percurso', color: '#607d8b',
      body: () => `
        <div class="form-grid">
          ${field('vehicle_id', 'Veículo', select('vehicle_id', vehOpts()))}
          ${field('start_date', 'Data', `<input id="f_start_date" name="start_date" type="date" value="${today}" required>`)}
          ${field('origin_id', 'Origem', select('origin_id', [{ v: '', t: '—' }, ...opt(L.places)]))}
          ${field('destination_id', 'Destino', select('destination_id', [{ v: '', t: '—' }, ...opt(L.places)]))}
          ${odoField('start_odometer', 'Odômetro inicial (km)', { req: true })}
          ${odoField('end_odometer', 'Odômetro final (km)', { optional: true })}
          ${field('distance_value', 'Valor por km (R$)', `<input id="f_distance_value" name="distance_value" type="number" step="0.01" min="0" value="0" data-type=number>`)}
          ${field('freight_value', 'Valor do frete (R$)', `<input id="f_freight_value" name="freight_value" type="number" step="0.01" min="0" value="0" data-type=number>`)}
          ${field('driver_id', 'Motorista', select('driver_id', [{ v: '', t: '—' }, ...opt(L.drivers)]))}
          ${field('reason_id', 'Motivo', select('reason_id', [{ v: '', t: '—' }, ...opt(L.reason_types)]))}
          ${field('notes', 'Observação', `<textarea id="f_notes" name="notes"></textarea>`, { full: true })}
        </div>`,
      onReady: (form) => wireOdoHints(form),
      endpoint: '/api/routes',
    },
    reading: {
      title: 'Nova leitura', color: '#c2185b',
      body: () => `
        <div class="form-grid">
          ${field('vehicle_id', 'Veículo', select('vehicle_id', vehOpts()))}
          ${field('date', 'Data', `<input id="f_date" name="date" type="date" value="${today}" required>`)}
          ${odoField('odometer', 'Odômetro (km)', { req: true, help: 'Para corrigir o odômetro quando ele diverge do registro' })}
          ${field('notes', 'Observação', `<textarea id="f_notes" name="notes"></textarea>`, { full: true })}
        </div>`,
      onReady: (form) => wireOdoHints(form),
      endpoint: '/api/readings',
    },
    reminder: {
      title: 'Novo lembrete', color: '#673ab7',
      body: () => `
        <div class="form-grid">
          ${field('vehicle_id', 'Veículo', select('vehicle_id', vehOpts()))}
          ${field('title', 'Título', `<input id="f_title" name="title" required placeholder="Ex.: Troca de óleo">`, { req: true })}
          ${field('kind', 'Disparar por', `<select id="f_kind" name="kind"><option value="date">Data</option><option value="odometer">Odômetro</option></select>`)}
          ${field('due_date', 'Data do vencimento', `<input id="f_due_date" name="due_date" type="date">`)}
          ${odoField('due_odometer', 'Odômetro alvo (km)', { step: '1', optional: true })}
          ${field('repeat_days', 'Repetir a cada (dias)', `<input id="f_repeat_days" name="repeat_days" type="number" min="0" data-type=number data-optional=1>`)}
          ${field('repeat_km', 'Repetir a cada (km)', `<input id="f_repeat_km" name="repeat_km" type="number" min="0" data-type=number data-optional=1>`)}
          ${field('active', 'Ativo', `<select id="f_active" name="active"><option value="1">Sim</option><option value="0">Não</option></select>`)}
          ${field('notes', 'Observação', `<textarea id="f_notes" name="notes"></textarea>`, { full: true })}
        </div>`,
      onReady: (form) => wireOdoHints(form),
      endpoint: '/api/reminders',
    },
  };

  const def = defs[kind];
  if (!def) return;
  modal(def.title, def.body(), async (body) => {
    if (def.before) def.before(body);
    if (!body.vehicle_id) body.vehicle_id = vid;
    if (kind === 'reminder') {
      if (body.kind === 'date' && !body.due_date) throw new Error('Informe a data do vencimento.');
      if (body.kind === 'odometer' && body.due_odometer == null) throw new Error('Informe o odômetro alvo.');
      if (body.kind === 'date') delete body.due_odometer;
      if (body.kind === 'odometer') delete body.due_date;
    }
    await api(def.endpoint, { method: 'POST', body });
    toast('Registro salvo com sucesso!', 'ok');
    router();
  }, def.onReady ? { onReady: def.onReady } : undefined);
}

async function openEdit(kind, row) {
  if (!row) return;
  const L = await loadLookups();
  const defs = {
    refueling: {
      title: 'Editar abastecimento', endpoint: '/api/refuelings',
      body: () => `
        <div class="form-grid">
          ${field('date', 'Data', `<input id="f_date" name="date" type="date" value="${esc(row.date?.slice(0,10) || '')}" required>`, { req: true })}
          <div class="field">
            <label for="f_odometer">Odômetro (km) <span class="req">*</span> <span class="muted" id="odo-last" style="font-weight:400"></span></label>
            <input id="f_odometer" name="odometer" type="number" step="0.1" min="0" required data-type="number" value="${row.odometer ?? ''}">
            <div class="help">Leitura atual do painel</div>
          </div>
          ${field('volume', 'Volume (L)', `<input id="f_volume" name="volume" type="number" step="0.001" min="0" data-type="number" value="${row.volume ?? ''}">`, { help: 'Preenchido automaticamente se informar preço e total' })}
          ${field('price', 'Preço por litro (R$)', `<input id="f_price" name="price" type="number" step="0.001" min="0" data-type="number" value="${row.price ?? ''}">`, { help: 'Preenchido automaticamente se informar volume e total' })}
          ${field('total', 'Valor total (R$)', `<input id="f_total" name="total" type="number" step="0.01" min="0" data-type="number" value="${row.total ?? ''}">`, { help: 'Preenchido automaticamente se informar volume e preço' })}
          ${field('fuel_id', 'Combustível', select('fuel_id', [{ v: '', t: '—' }, ...opt(L.fuels)]))}
          ${field('station_id', 'Posto', select('station_id', [{ v: '', t: '—' }, ...opt(L.stations)]))}
          ${field('payment_id', 'Forma de pagamento', select('payment_id', [{ v: '', t: '—' }, ...opt(L.payment_methods)]))}
          ${field('discount', 'Desconto (R$)', `<input id="f_discount" name="discount" type="number" step="0.01" min="0" value="${row.discount ?? 0}" data-type="number">`)}
          <div class="field full check" style="padding-top:0">
            <input type="checkbox" id="f_full_tank" name="full_tank" value="1" ${row.full_tank ? 'checked' : ''} />
            <label for="f_full_tank" style="margin:0;font-weight:600">Tanque cheio</label>
          </div>
          ${field('notes', 'Observação', `<textarea id="f_notes" name="notes" placeholder="Opcional">${esc(row.notes || '')}</textarea>`, { full: true })}
        </div>`,
      before: (b) => {
        const v = b.volume != null ? Number(b.volume) : NaN;
        const p = b.price  != null ? Number(b.price)  : NaN;
        const t = b.total  != null ? Number(b.total)  : NaN;
        if (!Number.isFinite(b.total)  && Number.isFinite(v) && Number.isFinite(p) && v > 0 && p > 0) b.total  = Number((v * p).toFixed(2));
        if (!Number.isFinite(b.volume) && Number.isFinite(t) && Number.isFinite(p) && t > 0 && p > 0) b.volume = Number((t / p).toFixed(3));
        if (!Number.isFinite(b.price)  && Number.isFinite(t) && Number.isFinite(v) && t > 0 && v > 0) b.price  = Number((t / v).toFixed(3));
        if (!Number.isFinite(Number(b.total)))  b.total = 0;
        if (!Number.isFinite(Number(b.volume))) b.volume = 0;
        if (!Number.isFinite(Number(b.price)))  b.price = 0;
        b.total = Number(b.total); b.volume = Number(b.volume); b.price = Number(b.price);
        if (b.full_tank === undefined) b.full_tank = 0;
        return b;
      },
      onReady: (form) => {
        // preselect lookups
        if (row.station_id) form.elements['station_id'].value = String(row.station_id);
        if (row.fuel_id) form.elements['fuel_id'].value = String(row.fuel_id);
        if (row.payment_id) form.elements['payment_id'].value = String(row.payment_id);

        const hint = form.querySelector('#odo-last');
        const updateOdo = async () => {
          const id = Number(row.vehicle_id || 0);
          if (!id) { if (hint) hint.textContent = ''; return; }
          try {
            const r = await api(`/api/last-odometer?vehicle_id=${id}`);
            hint.textContent = r.odometer != null ? `| Último: ${fmtNum(r.odometer, 0)}` : '| Último: —';
          } catch { if (hint) hint.textContent = ''; }
        };
        updateOdo();

        const vol = form.elements['volume'];
        const pri = form.elements['price'];
        const tot = form.elements['total'];
        const toNum = (el) => { const n = Number(el.value); return el.value !== '' && Number.isFinite(n) ? n : NaN; };
        const recalc = (src) => {
          const v = toNum(vol), p = toNum(pri), t = toNum(tot);
          if (src !== 'total'  && Number.isFinite(v) && v > 0 && Number.isFinite(p) && p > 0) tot.value = (v * p).toFixed(2);
          else if (src !== 'volume' && Number.isFinite(t) && t > 0 && Number.isFinite(p) && p > 0) vol.value = (t / p).toFixed(3);
          else if (src !== 'price'  && Number.isFinite(t) && t > 0 && Number.isFinite(v) && v > 0) pri.value = (t / v).toFixed(3);
        };
        vol?.addEventListener('input', () => recalc('volume'));
        pri?.addEventListener('input', () => recalc('price'));
        tot?.addEventListener('input', () => recalc('total'));
      },
    },
    expense: {
      title: 'Editar despesa', endpoint: '/api/expenses',
      body: () => `
        <div class="form-grid">
          ${field('date', 'Data', `<input id="f_date" name="date" type="date" value="${esc(row.date?.slice(0,10)||'')}" required>`)}
          ${field('title', 'Título', `<input id="f_title" name="title" value="${esc(row.title||'')}" required>`, { req: true })}
          ${field('value', 'Valor (R$)', `<input id="f_value" name="value" type="number" step="0.01" min="0" data-type=number required value="${row.value ?? ''}">`, { req: true })}
          ${field('expense_type_id', 'Tipo de despesa', select('expense_type_id', [{ v: '', t: '—' }, ...opt(L.expense_types)]))}
          ${field('payment_id', 'Forma de pagamento', select('payment_id', [{ v: '', t: '—' }, ...opt(L.payment_methods)]))}
          ${field('place_id', 'Local', select('place_id', [{ v: '', t: '—' }, ...opt(L.places)]))}
          ${field('driver_id', 'Motorista', select('driver_id', [{ v: '', t: '—' }, ...opt(L.drivers)]))}
          ${odoField('odometer', 'Odômetro (km)', { value: row.odometer ?? '' })}
          ${field('installments', 'Parcelas', `<input id="f_installments" name="installments" type="number" min="1" value="${row.installments ?? 1}" data-type=number>`)}
          ${field('discount', 'Desconto (R$)', `<input id="f_discount" name="discount" type="number" step="0.01" min="0" value="${row.discount ?? 0}" data-type=number>`)}
          ${field('notes', 'Observação', `<textarea id="f_notes" name="notes">${esc(row.notes||'')}</textarea>`, { full: true })}
        </div>`,
      onReady: (form) => {
        ['expense_type_id','payment_id','place_id','driver_id'].forEach(k => { if (row[k]) form.elements[k].value = String(row[k]); });
        wireOdoHints(form, row.vehicle_id);
      },
    },
    service: {
      title: 'Editar serviço', endpoint: '/api/services',
      body: () => `
        <div class="form-grid">
          ${field('date', 'Data', `<input id="f_date" name="date" type="date" value="${esc(row.date?.slice(0,10)||'')}" required>`)}
          ${field('title', 'Título', `<input id="f_title" name="title" value="${esc(row.title||'')}" required>`, { req: true })}
          ${field('value', 'Valor (R$)', `<input id="f_value" name="value" type="number" step="0.01" min="0" data-type=number required value="${row.value ?? ''}">`, { req: true })}
          ${field('service_type_id', 'Tipo de serviço', select('service_type_id', [{ v: '', t: '—' }, ...opt(L.service_types)]))}
          ${field('payment_id', 'Forma de pagamento', select('payment_id', [{ v: '', t: '—' }, ...opt(L.payment_methods)]))}
          ${field('place_id', 'Local', select('place_id', [{ v: '', t: '—' }, ...opt(L.places)]))}
          ${field('driver_id', 'Motorista', select('driver_id', [{ v: '', t: '—' }, ...opt(L.drivers)]))}
          ${odoField('odometer', 'Odômetro (km)', { value: row.odometer ?? '' })}
          ${field('installments', 'Parcelas', `<input id="f_installments" name="installments" type="number" min="1" value="${row.installments ?? 1}" data-type=number>`)}
          ${field('discount', 'Desconto (R$)', `<input id="f_discount" name="discount" type="number" step="0.01" min="0" value="${row.discount ?? 0}" data-type=number>`)}
          ${field('notes', 'Observação', `<textarea id="f_notes" name="notes">${esc(row.notes||'')}</textarea>`, { full: true })}
        </div>`,
      onReady: (form) => {
        ['service_type_id','payment_id','place_id','driver_id'].forEach(k => { if (row[k]) form.elements[k].value = String(row[k]); });
        wireOdoHints(form, row.vehicle_id);
      },
    },
    income: {
      title: 'Editar receita', endpoint: '/api/incomes',
      body: () => `
        <div class="form-grid">
          ${field('date', 'Data', `<input id="f_date" name="date" type="date" value="${esc(row.date?.slice(0,10)||'')}" required>`)}
          ${field('value', 'Valor (R$)', `<input id="f_value" name="value" type="number" step="0.01" min="0" data-type=number required value="${row.value ?? ''}">`, { req: true })}
          ${field('income_type_id', 'Tipo de receita', select('income_type_id', [{ v: '', t: '—' }, ...opt(L.income_types)]))}
          ${odoField('odometer', 'Odômetro (km)', { value: row.odometer ?? '' })}
          ${field('installments', 'Parcelas', `<input id="f_installments" name="installments" type="number" min="1" value="${row.installments ?? 1}" data-type=number>`)}
          ${field('notes', 'Observação', `<textarea id="f_notes" name="notes">${esc(row.notes||'')}</textarea>`, { full: true })}
        </div>`,
      onReady: (form) => { if (row.income_type_id) form.elements['income_type_id'].value = String(row.income_type_id); wireOdoHints(form, row.vehicle_id); },
    },
    route: {
      title: 'Editar percurso', endpoint: '/api/routes',
      body: () => `
        <div class="form-grid">
          ${field('start_date', 'Data', `<input id="f_start_date" name="start_date" type="date" value="${esc(row.start_date?.slice(0,10)||'')}" required>`)}
          ${field('origin_id', 'Origem', select('origin_id', [{ v: '', t: '—' }, ...opt(L.places)]))}
          ${field('destination_id', 'Destino', select('destination_id', [{ v: '', t: '—' }, ...opt(L.places)]))}
          ${odoField('start_odometer', 'Odômetro inicial (km)', { req: true, value: row.start_odometer ?? '' })}
          ${odoField('end_odometer', 'Odômetro final (km)', { optional: true, value: row.end_odometer ?? '' })}
          ${field('distance_value', 'Valor por km (R$)', `<input id="f_distance_value" name="distance_value" type="number" step="0.01" min="0" value="${row.distance_value ?? 0}" data-type=number>`)}
          ${field('freight_value', 'Valor do frete (R$)', `<input id="f_freight_value" name="freight_value" type="number" step="0.01" min="0" value="${row.freight_value ?? 0}" data-type=number>`)}
          ${field('driver_id', 'Motorista', select('driver_id', [{ v: '', t: '—' }, ...opt(L.drivers)]))}
          ${field('reason_id', 'Motivo', select('reason_id', [{ v: '', t: '—' }, ...opt(L.reason_types)]))}
          ${field('notes', 'Observação', `<textarea id="f_notes" name="notes">${esc(row.notes||'')}</textarea>`, { full: true })}
        </div>`,
      onReady: (form) => {
        ['origin_id','destination_id','driver_id','reason_id'].forEach(k => { if (row[k]) form.elements[k].value = String(row[k]); });
        wireOdoHints(form, row.vehicle_id);
      },
    },
    reading: {
      title: 'Editar leitura', endpoint: '/api/readings',
      body: () => `
        <div class="form-grid">
          ${field('date', 'Data', `<input id="f_date" name="date" type="date" value="${esc(row.date?.slice(0,10)||'')}" required>`)}
          ${odoField('odometer', 'Odômetro (km)', { req: true, value: row.odometer ?? '' })}
          ${field('notes', 'Observação', `<textarea id="f_notes" name="notes">${esc(row.notes||'')}</textarea>`, { full: true })}
        </div>`,
      onReady: (form) => wireOdoHints(form, row.vehicle_id),
    },
    vehicle: { title: 'Editar veículo', endpoint: '/api/vehicles', body: () => vehicleFormHTML(row) },
    reminder: {
      title: 'Editar lembrete', endpoint: '/api/reminders',
      body: () => `
        <div class="form-grid">
          ${field('title', 'Título', `<input id="f_title" name="title" value="${esc(row.title)}" required>`)}
          ${field('kind', 'Disparar por', `<select id="f_kind" name="kind"><option value="date" ${row.kind==='date'?'selected':''}>Data</option><option value="odometer" ${row.kind==='odometer'?'selected':''}>Odômetro</option></select>`)}
          ${field('due_date', 'Data', `<input id="f_due_date" name="due_date" type="date" value="${esc(row.due_date || '')}">`)}
          ${odoField('due_odometer', 'Odômetro alvo (km)', { step: '1', optional: true, value: row.due_odometer ?? '' })}
          ${field('repeat_days', 'Repetir (dias)', `<input id="f_repeat_days" name="repeat_days" type="number" min="0" value="${row.repeat_days ?? ''}" data-type=number data-optional=1>`)}
          ${field('repeat_km', 'Repetir (km)', `<input id="f_repeat_km" name="repeat_km" type="number" min="0" value="${row.repeat_km ?? ''}" data-type=number data-optional=1>`)}
          ${field('active', 'Ativo', `<select id="f_active" name="active"><option value="1" ${row.active?'selected':''}>Sim</option><option value="0" ${!row.active?'selected':''}>Não</option></select>`)}
        </div>`,
      onReady: (form) => wireOdoHints(form, row.vehicle_id),
    },
  };
  const def = defs[kind];
  if (!def) return;
  modal(def.title, def.body(), async (body) => {
    await api(`${def.endpoint}/${row.id}`, { method: 'PUT', body });
    toast('Atualizado com sucesso!', 'ok');
    router();
  }, def.onReady ? { onReady: def.onReady } : undefined);
}

function vehicleFormHTML(v = {}) {
  return `
    <div class="form-grid">
      ${field('name', 'Nome', `<input id="f_name" name="name" value="${esc(v.name || '')}" required placeholder="Ex.: Gol">`, { req: true })}
      ${field('plate', 'Placa', `<input id="f_plate" name="plate" value="${esc(v.plate || '')}" placeholder="ABC1D23">`)}
      ${field('brand', 'Marca', `<input id="f_brand" name="brand" value="${esc(v.brand || '')}" placeholder="Volkswagen">`)}
      ${field('model', 'Modelo', `<input id="f_model" name="model" value="${esc(v.model || '')}" placeholder="Gol 1.6 MSI">`)}
      ${field('year', 'Ano', `<input id="f_year" name="year" type="number" min="1900" max="2100" value="${v.year || ''}" data-type=number>`)}
      ${field('fuel_type', 'Combustível', `<select id="f_fuel_type" name="fuel_type">${['Gasolina','Etanol','Flex','Diesel','Diesel S10','GNV','Elétrico','Híbrido'].map(f => `<option ${v.fuel_type === f ? 'selected' : ''}>${f}</option>`).join('')}</select>`)}
      ${field('tank_volume', 'Volume do tanque (L)', `<input id="f_tank_volume" name="tank_volume" type="number" step="0.1" min="0" value="${v.tank_volume ?? 50}" data-type=number>`)}
      ${field('odometer_unit', 'Unidade de distância', `<select id="f_odometer_unit" name="odometer_unit"><option value="1" ${v.odometer_unit===1||v.odometer_unit===undefined?'selected':''}>Quilômetros (km)</option><option value="2" ${v.odometer_unit===2?'selected':''}>Milhas (mi)</option></select>`)}
      ${field('active', 'Ativo', `<select id="f_active" name="active"><option value="1" ${(v.active ?? 1)?'selected':''}>Sim</option><option value="0" ${!v.active?'selected':''}>Não</option></select>`, { full: true })}
    </div>`;
}

function openVehicleForm(v) {
  modal(v ? 'Editar veículo' : 'Novo veículo', vehicleFormHTML(v || {}), async (body) => {
    if (v) await api(`/api/vehicles/${v.id}`, { method: 'PUT', body });
    else await api('/api/vehicles', { method: 'POST', body });
    state.vehicles = await api('/api/vehicles');
    toast(v ? 'Veículo atualizado!' : 'Veículo cadastrado!', 'ok');
    router();
  });
}

/* ---------- "Novo" menu from FAB ------------------------------------------ */
function openNewChooser() {
  const items = [
    { k: 'refueling', t: 'Abastecimento', i: '⛽', c: '#ff9800', s: '#fff3e0' },
    { k: 'expense',   t: 'Despesa',       i: '💸', c: '#e64a19', s: '#fbe9e7' },
    { k: 'service',   t: 'Serviço',       i: '🔧', c: '#795548', s: '#efebe9' },
    { k: 'income',    t: 'Receita',       i: '💰', c: '#2e7d32', s: '#e8f5e9' },
    { k: 'route',     t: 'Percurso',      i: '🛣️', c: '#607d8b', s: '#eceff1' },
    { k: 'reading',   t: 'Leitura',       i: '📍', c: '#c2185b', s: '#fce4ec' },
    { k: 'reminder',  t: 'Lembrete',      i: '🔔', c: '#673ab7', s: '#ede7f6' },
    { k: 'vehicle',   t: 'Veículo',       i: '🚗', c: '#0097a7', s: '#e0f7fa' },
  ];
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" style="max-width:470px">
      <div class="modal-head"><h3>Novo registro</h3><button class="x">&times;</button></div>
      <div class="modal-body">
        <div class="quick-actions" style="grid-template-columns:repeat(3,1fr)">
          ${items.map((q) => `
            <button class="qa" data-k="${q.k}" style="--c:${q.c};--c-soft:${q.s}">
              <span class="qa-ico">${q.i}</span>${q.t}
            </button>`).join('')}
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  $('.x', ov).onclick = close;
  $$('[data-k]', ov).forEach((b) => (b.onclick = () => { close(); openNew(b.dataset.k); }));
}

// expose to inline handlers used by dashboard
window.__openNew = openNew;

/* ==========================================================================
   boot
   ========================================================================== */
async function boot() {
  try {
    state.user = await api('/api/me');
  } catch {
    return renderAuth();
  }
  await loadVehicles();
  if (!location.hash) location.hash = '#/dashboard';

  // intercept FAB route
  const origRouter = router;
  window.addEventListener('hashchange', () => {
    if (location.hash === '#/novo') {
      history.replaceState(null, '', '#/dashboard');
      openNewChooser();
    }
  });

  router();
  if (location.hash === '#/novo') {
    history.replaceState(null, '', '#/dashboard');
    openNewChooser();
  }
}

boot();
