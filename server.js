'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, init, createUser, verifyUser } = require('./db');

const PORT = Number(process.env.PORT || 3000);
const ymExpr = (col) => db.driver === 'mysql' ? `DATE_FORMAT(${col}, '%Y-%m')` : `strftime('%Y-%m', ${col})`;
const PUBLIC = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      raw += c;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// --- sessions (DB-backed, survives restart) ------------------------------
async function getSession(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)sid=([a-f0-9]{64})/);
  if (!m) return null;
  const row = await db.get('SELECT user_id FROM sessions WHERE sid = ?', m[1]);
  return row ? row.user_id : null;
}
async function createSession(userId) {
  const sid = crypto.randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (sid, user_id) VALUES (?, ?)', sid, userId);
  return sid;
}
async function deleteSession(sid) {
  await db.run('DELETE FROM sessions WHERE sid = ?', sid);
}

// --- date range helper used by reports -------------------------------------
// Mirrors FiltroRelatorioDTO.a(int): 1=1 month, 2=3 months, 3=6 months,
// 4=1 year, 5=all, 6=custom, 7=this month, 8=last month.
function periodRange(period, from, to) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const fmt = (d) => d.toISOString().slice(0, 10);
  const monthsBack = (n) => {
    const d = startOfDay(now);
    d.setMonth(d.getMonth() - n);
    return d;
  };
  switch (Number(period)) {
    case 1: return { from: fmt(monthsBack(1)), to: fmt(now) };
    case 2: return { from: fmt(monthsBack(3)), to: fmt(now) };
    case 3: return { from: fmt(monthsBack(6)), to: fmt(now) };
    case 4: return { from: fmt(monthsBack(12)), to: fmt(now) };
    case 7: {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: fmt(s), to: fmt(now) };
    }
    case 8: {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: fmt(s), to: fmt(e) };
    }
    case 6: return { from: from || fmt(monthsBack(3)), to: to || fmt(now) };
    default: return { from: null, to: fmt(now) }; // 5 = all
  }
}

// ---------------------------------------------------------------------------
// Domain calculations
// ---------------------------------------------------------------------------

// Fuel efficiency exactly like the app: between two consecutive full-tank
// fill-ups, distance = odometer delta, volume = sum of volume in the span.
async function efficiencySeries(vehicleId) {
  const rows = await db
    .prepare(
      `SELECT id, date, odometer, volume, total, full_tank, price, station_id
         FROM refuelings WHERE vehicle_id = ? ORDER BY date, id`
    )
    .all(vehicleId);

  const out = [];
  let anchor = null;   // last full-tank fill-up
  let accVolume = 0;
  let accTotal = 0;

  for (const r of rows) {
    if (anchor) {
      accVolume += r.volume || 0;
      accTotal += r.total || 0;
    }
    if (r.full_tank) {
      if (anchor) {
        const distance = r.odometer - anchor.odometer;
        if (distance > 0 && accVolume > 0) {
          out.push({
            date: r.date,
            odometer: r.odometer,
            distance: Number(distance.toFixed(1)),
            volume: Number(accVolume.toFixed(3)),
            total: Number(accTotal.toFixed(2)),
            kmPerL: Number((distance / accVolume).toFixed(2)),
            costPerKm: Number((accTotal / distance).toFixed(3)),
            priceAvg: Number((accTotal / accVolume).toFixed(3)),
          });
        }
      }
      anchor = r;
      accVolume = 0;
      accTotal = 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// API router
// ---------------------------------------------------------------------------
const routes = [];
function route(method, pattern, handler, auth = true) {
  const keys = [];
  const rx = new RegExp(
    '^' +
      pattern.replace(/:[A-Za-z]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      }) +
      '$'
  );
  routes.push({ method, rx, keys, handler, auth });
}

// --- auth ------------------------------------------------------------------
route('POST', '/api/register', async (req, res, params, body) => {
  const { name, email, password } = body;
  if (!name || !email || !password) return sendJSON(res, 400, { error: 'Preencha todos os campos.' });
  if (String(password).length < 6) return sendJSON(res, 400, { error: 'A senha deve ter ao menos 6 caracteres.' });
  try {
    const id = await createUser(name, email, password);
    const sid = await createSession(id);
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
    return sendJSON(res, 201, { id, name, email: email.toLowerCase() });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return sendJSON(res, 409, { error: 'E-mail já cadastrado.' });
    throw e;
  }
}, false);

route('POST', '/api/login', async (req, res, params, body) => {
  const user = await verifyUser(body.email, body.password);
  if (!user) return sendJSON(res, 401, { error: 'E-mail ou senha inválidos.' });
  const sid = await createSession(user.id);
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
  return sendJSON(res, 200, { id: user.id, name: user.name, email: user.email });
}, false);

route('POST', '/api/logout', async (req, res) => {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)sid=([a-f0-9]{64})/);
  if (m) await deleteSession(m[1]);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  return sendJSON(res, 200, { ok: true });
}, false);

route('GET', '/api/me', async (req, res, params, body, user) => {
  return sendJSON(res, 200, { id: user.id, name: user.name, email: user.email });
});

async function ensureQuickToken(userId) {
  let row = await db.prepare('SELECT quick_token FROM users WHERE id = ?').get(userId);
  if (row && row.quick_token) return row.quick_token;
  const token = crypto.randomBytes(24).toString('hex');
  await db.prepare('UPDATE users SET quick_token = ? WHERE id = ?').run(token, userId);
  return token;
}

async function userByQuickToken(req, url) {
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const token = bearer || url.searchParams.get('token') || req.headers['x-quick-token'] || '';
  if (!token) return null;
  return await db.prepare('SELECT id, name, email FROM users WHERE quick_token = ?').get(token) || null;
}

route('GET', '/api/quick-token', async (req, res, params, body, user) => {
  return sendJSON(res, 200, { token: await ensureQuickToken(user.id) });
});

route('POST', '/api/quick-token', async (req, res, params, body, user) => {
  const token = crypto.randomBytes(24).toString('hex');
  await db.prepare('UPDATE users SET quick_token = ? WHERE id = ?').run(token, user.id);
  return sendJSON(res, 200, { token });
});

route('POST', '/api/quick/refueling', async (req, res, params, body) => {
  const url = new URL(req.url, 'http://x');
  const user = await userByQuickToken(req, url);
  if (!user) return sendJSON(res, 401, { error: 'Token inválido.' });

  const vehicleId = Number(body.vehicle_id || 0);
  const vehicle = vehicleId
    ? await db.prepare('SELECT id FROM vehicles WHERE id = ? AND user_id = ?').get(vehicleId, user.id)
    : await db.prepare('SELECT id FROM vehicles WHERE user_id = ? AND active = 1 ORDER BY id LIMIT 1').get(user.id);
  if (!vehicle) return sendJSON(res, 400, { error: 'Veículo não encontrado.' });

  const odometer = Number(body.odometer);
  if (!Number.isFinite(odometer)) return sendJSON(res, 400, { error: 'Odômetro inválido.' });

  let volume = body.volume === '' || body.volume == null ? NaN : Number(body.volume);
  let price  = body.price  === '' || body.price  == null ? NaN : Number(body.price);
  let total  = body.total  === '' || body.total  == null ? NaN : Number(body.total);
  if (!Number.isFinite(total)  && Number.isFinite(volume) && Number.isFinite(price) && volume > 0 && price > 0) total  = Number((volume * price).toFixed(2));
  if (!Number.isFinite(volume) && Number.isFinite(total)  && Number.isFinite(price) && total > 0 && price > 0) volume = Number((total / price).toFixed(3));
  if (!Number.isFinite(price)  && Number.isFinite(total)  && Number.isFinite(volume) && total > 0 && volume > 0) price  = Number((total / volume).toFixed(3));
  if (!Number.isFinite(total))  total = 0;
  if (!Number.isFinite(volume)) volume = 0;
  if (!Number.isFinite(price))  price = 0;

  const date = (body.date && /^\d{4}-\d{2}-\d{2}/.test(body.date)) ? body.date.slice(0,10) : new Date().toISOString().slice(0,10);
  const fullTank = body.full_tank ? 1 : 0;
  const notes = body.notes ? String(body.notes).slice(0, 500) : null;
  const fuelId = body.fuel_id ? Number(body.fuel_id) : null;
  const stationId = body.station_id ? Number(body.station_id) : null;

  const info = await db.prepare(`
    INSERT INTO refuelings (user_id, vehicle_id, date, odometer, price, volume, total, full_tank, discount, fuel_id, station_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(user.id, vehicle.id, date, odometer, price, volume, total, fullTank, fuelId, stationId, notes);
  const row = await db.prepare('SELECT * FROM refuelings WHERE id = ?').get(Number(info.lastInsertRowid));
  return sendJSON(res, 201, { ok: true, refueling: row });
}, false);

route('GET', '/api/quick/bootstrap', async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const user = await userByQuickToken(req, url);
  if (!user) return sendJSON(res, 401, { error: 'Token inválido.' });
  const vehicles = await db.prepare('SELECT id, name, fuel_type, tank_volume FROM vehicles WHERE user_id = ? AND active = 1 ORDER BY id').all(user.id);
  const fuels = await db.prepare('SELECT id, name FROM fuels WHERE user_id = ? AND active = 1 ORDER BY name').all(user.id);
  const stations = await db.prepare('SELECT id, name FROM stations WHERE user_id = ? AND active = 1 ORDER BY name').all(user.id);
  return sendJSON(res, 200, { user: { name: user.name }, vehicles, fuels, stations });
}, false);

route('POST', '/api/import/:kind', async (req, res, params, body, user) => {
  const kind = params.kind;
  const allowed = new Set(['refuelings','expenses','services','incomes','routes','readings']);
  if (!allowed.has(kind)) return sendJSON(res, 400, { error: 'Tipo de importação inválido.' });
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return sendJSON(res, 400, { error: 'Nenhuma linha enviada.' });
  const vehicleId = Number(body.vehicle_id || 0);
  const vehicle = vehicleId
    ? await db.prepare('SELECT id FROM vehicles WHERE id = ? AND user_id = ?').get(vehicleId, user.id)
    : await db.prepare('SELECT id FROM vehicles WHERE user_id = ? AND active = 1 ORDER BY id LIMIT 1').get(user.id);
  if (!vehicle) return sendJSON(res, 400, { error: 'Veículo não encontrado.' });

  const findOrCreate = async (table, name) => {
    const n = String(name || '').trim();
    if (!n) return null;
    const ex = await db.prepare(`SELECT id FROM ${table} WHERE user_id = ? AND lower(name) = lower(?)`).get(user.id, n);
    if (ex) return ex.id;
    return Number(await db.prepare(`INSERT INTO ${table} (user_id, name) VALUES (?, ?)`).run(user.id, n).lastInsertRowid);
  };
  const pick = (r, keys) => { for (const k of keys) { const v = r[k] ?? r[k.toLowerCase()] ?? r[k.toUpperCase()]; if (v !== undefined && v !== null && v !== '') return v; } return null; };
  const toNum = (v) => {
    if (v === null || v === undefined || v === '') return NaN;
    let s = String(v).trim().replace(/\s/g,'').replace(/[^\d.,-]/g,'');
    const hasDot = s.includes('.'), hasComma = s.includes(',');
    if (hasDot && hasComma) {
      // last separator is decimal
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g,'').replace(',', '.');
      else s = s.replace(/,/g,'');
    } else if (hasComma) {
      s = s.replace(/\./g,'').replace(',', '.');
    } else if (hasDot) {
      // single dot: keep as decimal unless clearly thousands grouping like 1.234.567
      const parts = s.split('.');
      if (parts.length > 2) s = s.replace(/\./g,'');
      // else keep dot as decimal
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  };
  const toDate = (v) => {
    const s = String(v || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (m) { const y = m[3].length === 2 ? ('20'+m[3]) : m[3]; return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
    return null;
  };
  const toBool = (v) => { const s = String(v ?? '').toLowerCase(); return (s==='1'||s==='sim'||s==='true'||s==='s'||s==='yes') ? 1 : 0; };
  const note = (r) => { const n = pick(r,['notes','observacao','observação','obs','descricao','descrição']); return n ? String(n).slice(0,500) : null; };

  const stmts = {
    refuelings: () => db.prepare(`INSERT INTO refuelings (user_id,vehicle_id,date,odometer,price,volume,total,full_tank,discount,fuel_id,station_id,notes) VALUES (?,?,?,?,?,?,?,?,0,?,?,?)`),
    expenses:   () => db.prepare(`INSERT INTO expenses (user_id,vehicle_id,date,odometer,title,value,discount,installments,expense_type_id,payment_id,place_id,driver_id,notes) VALUES (?,?,?,?,?,?,0,1,?,?,?,?,?)`),
    services:   () => db.prepare(`INSERT INTO services (user_id,vehicle_id,date,odometer,title,value,discount,installments,service_type_id,payment_id,place_id,driver_id,notes) VALUES (?,?,?,?,?,?,0,1,?,?,?,?,?)`),
    incomes:    () => db.prepare(`INSERT INTO incomes (user_id,vehicle_id,date,odometer,value,installments,income_type_id,notes) VALUES (?,?,?,?,?,1,?,?)`),
    routes:     () => db.prepare(`INSERT INTO routes (user_id,vehicle_id,origin_id,destination_id,start_date,end_date,start_odometer,end_odometer,distance_value,freight_value,driver_id,reason_id,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    readings:   () => db.prepare(`INSERT INTO readings (user_id,vehicle_id,date,odometer,notes) VALUES (?,?,?,?,?)`),
  };
  const ins = stmts[kind]();

  let imported = 0; const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    try {
      if (kind === 'refuelings') {
        const date = toDate(pick(r,['date','data'])); const odometer = toNum(pick(r,['odometer','odometro','km','quilometragem']));
        let volume = toNum(pick(r,['volume','litros'])); let price = toNum(pick(r,['price','preco','preco_litro'])); let total = toNum(pick(r,['total','valor','valor_total']));
        if (!date || !Number.isFinite(odometer)) { errors.push(`Linha ${i+1}: data/odômetro inválido`); continue; }
        if (!Number.isFinite(total) && Number.isFinite(volume) && Number.isFinite(price)) total = Number((volume*price).toFixed(2));
        if (!Number.isFinite(volume) && Number.isFinite(total) && Number.isFinite(price) && price>0) volume = Number((total/price).toFixed(3));
        if (!Number.isFinite(price) && Number.isFinite(total) && Number.isFinite(volume) && volume>0) price = Number((total/volume).toFixed(3));
        if (!Number.isFinite(total)) total=0; if (!Number.isFinite(volume)) volume=0; if (!Number.isFinite(price)) price=0;
        const fuelId = await findOrCreate('fuels', pick(r,['fuel','combustivel','combustível']));
        const stationId = await findOrCreate('stations', pick(r,['station','posto']));
        await ins.run(user.id, vehicle.id, date, odometer, price, volume, total, toBool(pick(r,['full_tank','tanque_cheio','completo'])), fuelId, stationId, note(r));
      } else if (kind === 'expenses') {
        const date = toDate(pick(r,['date','data'])); const value = toNum(pick(r,['value','valor','total']));
        const title = String(pick(r,['title','titulo','título','descricao','descrição']) || 'Despesa').slice(0,200);
        if (!date || !Number.isFinite(value)) { errors.push(`Linha ${i+1}: data/valor inválido`); continue; }
        const odo = toNum(pick(r,['odometer','odometro','km'])); 
        const expenseTypeId = await findOrCreate('expense_types', pick(r,['type','tipo','categoria']));
        const paymentId = await findOrCreate('payment_methods', pick(r,['payment','pagamento','forma_pagamento']));
        const placeId = await findOrCreate('places', pick(r,['place','local']));
        const driverId = await findOrCreate('drivers', pick(r,['driver','motorista']));
        await ins.run(user.id, vehicle.id, date, Number.isFinite(odo)?odo:null, title, value, expenseTypeId, paymentId, placeId, driverId, note(r));
      } else if (kind === 'services') {
        const date = toDate(pick(r,['date','data'])); const value = toNum(pick(r,['value','valor','total']));
        const title = String(pick(r,['title','titulo','título','descricao','descrição']) || 'Serviço').slice(0,200);
        if (!date || !Number.isFinite(value)) { errors.push(`Linha ${i+1}: data/valor inválido`); continue; }
        const odo = toNum(pick(r,['odometer','odometro','km']));
        const serviceTypeId = await findOrCreate('service_types', pick(r,['type','tipo','categoria']));
        const paymentId = await findOrCreate('payment_methods', pick(r,['payment','pagamento','forma_pagamento']));
        const placeId = await findOrCreate('places', pick(r,['place','local']));
        const driverId = await findOrCreate('drivers', pick(r,['driver','motorista']));
        await ins.run(user.id, vehicle.id, date, Number.isFinite(odo)?odo:null, title, value, serviceTypeId, paymentId, placeId, driverId, note(r));
      } else if (kind === 'incomes') {
        const date = toDate(pick(r,['date','data'])); const value = toNum(pick(r,['value','valor','total']));
        if (!date || !Number.isFinite(value)) { errors.push(`Linha ${i+1}: data/valor inválido`); continue; }
        const odo = toNum(pick(r,['odometer','odometro','km']));
        const incomeTypeId = await findOrCreate('income_types', pick(r,['type','tipo','categoria']));
        await ins.run(user.id, vehicle.id, date, Number.isFinite(odo)?odo:null, value, incomeTypeId, note(r));
      } else if (kind === 'routes') {
        const date = toDate(pick(r,['start_date','date','data'])); const so = toNum(pick(r,['start_odometer','odometro_inicial','km_inicial']));
        if (!date || !Number.isFinite(so)) { errors.push(`Linha ${i+1}: data/odômetro inicial inválido`); continue; }
        const eo = toNum(pick(r,['end_odometer','odometro_final','km_final'])); const dv = toNum(pick(r,['distance_value','valor_km'])); const fv = toNum(pick(r,['freight_value','frete','valor_frete']));
        const originId = await findOrCreate('places', pick(r,['origin','origem']));
        const destId = await findOrCreate('places', pick(r,['destination','destino']));
        const driverId = await findOrCreate('drivers', pick(r,['driver','motorista']));
        const reasonId = await findOrCreate('reason_types', pick(r,['reason','motivo']));
        await ins.run(user.id, vehicle.id, originId, destId, date, toDate(pick(r,['end_date','data_fim'])) || date, so, Number.isFinite(eo)?eo:null, Number.isFinite(dv)?dv:0, Number.isFinite(fv)?fv:0, driverId, reasonId, note(r));
      } else if (kind === 'readings') {
        const date = toDate(pick(r,['date','data'])); const odometer = toNum(pick(r,['odometer','odometro','km','leitura']));
        if (!date || !Number.isFinite(odometer)) { errors.push(`Linha ${i+1}: data/odômetro inválido`); continue; }
        await ins.run(user.id, vehicle.id, date, odometer, note(r));
      }
      imported++;
    } catch (e) { errors.push(`Linha ${i+1}: ${e.message}`); }
  }
  return sendJSON(res, 200, { ok: true, imported, errors: errors.slice(0, 20) });
});

// --- generic CRUD factory --------------------------------------------------
function crud(table, columns, opts = {}) {
  const cols = columns.filter((c) => c !== 'user_id');
  const listCols = ['id', ...cols].join(', ');

  route('GET', `/api/${table}`, async (req, res, params, body, user) => {
    const rows = await db
      .prepare(`SELECT ${listCols} FROM ${table} WHERE user_id = ? ORDER BY ${opts.orderBy || 'name'}`)
      .all(user.id);
    return sendJSON(res, 200, rows);
  });

  route('GET', `/api/${table}/:id`, async (req, res, params, body, user) => {
    const row = await db.prepare(`SELECT ${listCols} FROM ${table} WHERE id = ? AND user_id = ?`).get(Number(params.id), user.id);
    if (!row) return sendJSON(res, 404, { error: 'Registro não encontrado.' });
    return sendJSON(res, 200, row);
  });

  const norm = (v) => (v === '' ? null : v);

  route('POST', `/api/${table}`, async (req, res, params, body, user) => {
    const send = cols.filter((c) => body[c] !== undefined);
    if (!send.length) return sendJSON(res, 400, { error: 'Nenhum campo enviado.' });
    const sql = `INSERT INTO ${table} (user_id, ${send.join(', ')}) VALUES (?, ${send.map(() => '?').join(', ')})`;
    const info = await db.prepare(sql).run(user.id, ...send.map((c) => norm(body[c])));
    const row = await db.prepare(`SELECT ${listCols} FROM ${table} WHERE id = ?`).get(Number(info.lastInsertRowid));
    return sendJSON(res, 201, row);
  });

  route('PUT', `/api/${table}/:id`, async (req, res, params, body, user) => {
    const send = cols.filter((c) => body[c] !== undefined);
    if (!send.length) return sendJSON(res, 400, { error: 'Nenhum campo enviado.' });
    const sql = `UPDATE ${table} SET ${send.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND user_id = ?`;
    const info = await db.prepare(sql).run(...send.map((c) => norm(body[c])), Number(params.id), user.id);
    if (!info.changes) return sendJSON(res, 404, { error: 'Registro não encontrado.' });
    const row = await db.prepare(`SELECT ${listCols} FROM ${table} WHERE id = ?`).get(Number(params.id));
    return sendJSON(res, 200, row);
  });

  route('DELETE', `/api/${table}/:id`, async (req, res, params, body, user) => {
    const info = await db.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).run(Number(params.id), user.id);
    if (!info.changes) return sendJSON(res, 404, { error: 'Registro não encontrado.' });
    return sendJSON(res, 200, { ok: true });
  });
}

crud('vehicles', ['name', 'brand', 'model', 'year', 'plate', 'fuel_type', 'tank_volume', 'odometer_unit', 'active'], {
  orderBy: 'id',
});
crud('fuels', ['name', 'active']);
crud('stations', ['name', 'address', 'active']);
crud('places', ['name', 'address', 'active']);
crud('payment_methods', ['name', 'active']);
crud('expense_types', ['name', 'active']);
crud('service_types', ['name', 'active']);
crud('income_types', ['name', 'active']);
crud('reason_types', ['name', 'active']);
crud('drivers', ['name', 'active']);
crud('refuelings', [
  'vehicle_id', 'date', 'odometer', 'price', 'volume', 'total', 'full_tank', 'discount',
  'fuel_id', 'station_id', 'payment_id', 'driver_id', 'reason_id', 'notes',
], { orderBy: 'date DESC' });
crud('expenses', [
  'vehicle_id', 'date', 'odometer', 'title', 'value', 'discount', 'installments',
  'expense_type_id', 'payment_id', 'place_id', 'driver_id', 'reason_id', 'notes',
], { orderBy: 'date DESC' });
crud('services', [
  'vehicle_id', 'date', 'odometer', 'title', 'value', 'discount', 'installments',
  'service_type_id', 'payment_id', 'place_id', 'driver_id', 'notes',
], { orderBy: 'date DESC' });
crud('incomes', [
  'vehicle_id', 'date', 'odometer', 'value', 'installments', 'income_type_id', 'notes',
], { orderBy: 'date DESC' });
crud('routes', [
  'vehicle_id', 'origin_id', 'destination_id', 'start_date', 'end_date',
  'start_odometer', 'end_odometer', 'distance_value', 'freight_value',
  'driver_id', 'reason_id', 'notes',
], { orderBy: 'start_date DESC' });
crud('readings', ['vehicle_id', 'date', 'odometer', 'notes'], { orderBy: 'date DESC' });
crud('reminders', [
  'vehicle_id', 'kind', 'title', 'due_date', 'due_odometer', 'repeat_days', 'repeat_km', 'active', 'notes',
], { orderBy: 'id' });

// --- lookups used by forms (joins for readable labels) ----------------------
route('GET', '/api/refuelings/list', async (req, res, params, body, user) => {
  const rows = await db
    .prepare(
      `SELECT r.*, v.name AS vehicle_name, f.name AS fuel_name, s.name AS station_name,
              p.name AS payment_name, d.name AS driver_name, rt.name AS reason_name
         FROM refuelings r
         JOIN vehicles v ON v.id = r.vehicle_id
         LEFT JOIN fuels f ON f.id = r.fuel_id
         LEFT JOIN stations s ON s.id = r.station_id
         LEFT JOIN payment_methods p ON p.id = r.payment_id
         LEFT JOIN drivers d ON d.id = r.driver_id
         LEFT JOIN reason_types rt ON rt.id = r.reason_id
        WHERE r.user_id = ? ORDER BY r.date DESC, r.id DESC`
    )
    .all(user.id);
  return sendJSON(res, 200, rows);
});

route('GET', '/api/expenses/list', async (req, res, params, body, user) => {
  const rows = await db
    .prepare(
      `SELECT e.*, v.name AS vehicle_name, t.name AS type_name, p.name AS payment_name,
              l.name AS place_name, d.name AS driver_name, rt.name AS reason_name
         FROM expenses e
         JOIN vehicles v ON v.id = e.vehicle_id
         LEFT JOIN expense_types t ON t.id = e.expense_type_id
         LEFT JOIN payment_methods p ON p.id = e.payment_id
         LEFT JOIN places l ON l.id = e.place_id
         LEFT JOIN drivers d ON d.id = e.driver_id
         LEFT JOIN reason_types rt ON rt.id = e.reason_id
        WHERE e.user_id = ? ORDER BY e.date DESC, e.id DESC`
    )
    .all(user.id);
  return sendJSON(res, 200, rows);
});

route('GET', '/api/services/list', async (req, res, params, body, user) => {
  const rows = await db
    .prepare(
      `SELECT s.*, v.name AS vehicle_name, t.name AS type_name, p.name AS payment_name,
              l.name AS place_name, d.name AS driver_name
         FROM services s
         JOIN vehicles v ON v.id = s.vehicle_id
         LEFT JOIN service_types t ON t.id = s.service_type_id
         LEFT JOIN payment_methods p ON p.id = s.payment_id
         LEFT JOIN places l ON l.id = s.place_id
         LEFT JOIN drivers d ON d.id = s.driver_id
        WHERE s.user_id = ? ORDER BY s.date DESC, s.id DESC`
    )
    .all(user.id);
  return sendJSON(res, 200, rows);
});

route('GET', '/api/incomes/list', async (req, res, params, body, user) => {
  const rows = await db
    .prepare(
      `SELECT i.*, v.name AS vehicle_name, t.name AS type_name
         FROM incomes i
         JOIN vehicles v ON v.id = i.vehicle_id
         LEFT JOIN income_types t ON t.id = i.income_type_id
        WHERE i.user_id = ? ORDER BY i.date DESC, i.id DESC`
    )
    .all(user.id);
  return sendJSON(res, 200, rows);
});

route('GET', '/api/routes/list', async (req, res, params, body, user) => {
  const rows = await db
    .prepare(
      `SELECT r.*, v.name AS vehicle_name, o.name AS origin_name, d2.name AS destination_name,
              dr.name AS driver_name, rt.name AS reason_name
         FROM routes r
         JOIN vehicles v ON v.id = r.vehicle_id
         LEFT JOIN places o ON o.id = r.origin_id
         LEFT JOIN places d2 ON d2.id = r.destination_id
         LEFT JOIN drivers dr ON dr.id = r.driver_id
         LEFT JOIN reason_types rt ON rt.id = r.reason_id
        WHERE r.user_id = ? ORDER BY r.start_date DESC, r.id DESC`
    )
    .all(user.id);
  return sendJSON(res, 200, rows);
});

route('GET', '/api/readings/list', async (req, res, params, body, user) => {
  const rows = await db
    .prepare(
      `SELECT r.*, v.name AS vehicle_name FROM readings r
         JOIN vehicles v ON v.id = r.vehicle_id
        WHERE r.user_id = ? ORDER BY r.date DESC, r.id DESC`
    )
    .all(user.id);
  return sendJSON(res, 200, rows);
});

// --- dashboard --------------------------------------------------------------
route('GET', '/api/last-odometer', async (req, res, params, body, user) => {
  const url = new URL(req.url, 'http://x');
  if (!user) user = await userByQuickToken(req, url);
  if (!user) { const sid = await getSession(req); if (sid) user = await db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(sid); }
  if (!user) return sendJSON(res, 401, { error: 'Não autenticado.' });
  const vehicleId = Number(url.searchParams.get('vehicle_id') || 0);
  if (!vehicleId) return sendJSON(res, 400, { error: 'vehicle_id obrigatório.' });
  const own = await db.prepare('SELECT id FROM vehicles WHERE id = ? AND user_id = ?').get(vehicleId, user.id);
  if (!own) return sendJSON(res, 404, { error: 'Veículo não encontrado.' });
  const row = await db.prepare(`
    SELECT max(odometer) odometer FROM (
      SELECT odometer FROM refuelings WHERE vehicle_id = ? AND user_id = ?
      UNION ALL SELECT odometer FROM expenses WHERE vehicle_id = ? AND user_id = ? AND odometer IS NOT NULL
      UNION ALL SELECT odometer FROM services WHERE vehicle_id = ? AND user_id = ? AND odometer IS NOT NULL
      UNION ALL SELECT odometer FROM incomes  WHERE vehicle_id = ? AND user_id = ? AND odometer IS NOT NULL
      UNION ALL SELECT end_odometer   AS odometer FROM routes WHERE vehicle_id = ? AND user_id = ? AND end_odometer IS NOT NULL
      UNION ALL SELECT start_odometer AS odometer FROM routes WHERE vehicle_id = ? AND user_id = ? AND start_odometer IS NOT NULL
      UNION ALL SELECT odometer FROM readings WHERE vehicle_id = ? AND user_id = ?
    )
  `).get(vehicleId, user.id, vehicleId, user.id, vehicleId, user.id, vehicleId, user.id, vehicleId, user.id, vehicleId, user.id, vehicleId, user.id);
  return sendJSON(res, 200, { vehicle_id: vehicleId, odometer: row?.odometer ?? null });
}, false);

route('GET', '/api/dashboard', async (req, res, params, body, user) => {
  const url = new URL(req.url, 'http://x');
  const vehicleId = url.searchParams.get('vehicle_id');
  const vid = vehicleId ? Number(vehicleId) : null;
  const vFilter = vid ? 'AND vehicle_id = ?' : '';
  const vArgs = vid ? [vid] : [];

  const one = async (sql, ...args) => await db.prepare(sql).get(...args);

  const refuelCount = (await one(`SELECT count(*) c FROM refuelings WHERE user_id = ? ${vFilter}`, user.id, ...vArgs)).c;
  const expenseCount = (await one(`SELECT count(*) c FROM expenses WHERE user_id = ? ${vFilter}`, user.id, ...vArgs)).c;
  const serviceCount = (await one(`SELECT count(*) c FROM services WHERE user_id = ? ${vFilter}`, user.id, ...vArgs)).c;
  const incomeCount = (await one(`SELECT count(*) c FROM incomes WHERE user_id = ? ${vFilter}`, user.id, ...vArgs)).c;

  const expenseTotal = (await one(`SELECT coalesce(sum(value - discount),0) s FROM expenses WHERE user_id = ? ${vFilter}`, user.id, ...vArgs)).s;
  const serviceTotal = (await one(`SELECT coalesce(sum(value - discount),0) s FROM services WHERE user_id = ? ${vFilter}`, user.id, ...vArgs)).s;
  const incomeTotal = (await one(`SELECT coalesce(sum(value),0) s FROM incomes WHERE user_id = ? ${vFilter}`, user.id, ...vArgs)).s;
  const fuelTotal = (await one(`SELECT coalesce(sum(total - discount),0) s FROM refuelings WHERE user_id = ? ${vFilter}`, user.id, ...vArgs)).s;
  const volumeTotal = (await one(`SELECT coalesce(sum(volume),0) s FROM refuelings WHERE user_id = ? ${vFilter}`, user.id, ...vArgs)).s;
  const kmTotal = (await one(
    `SELECT coalesce(sum(end_odometer - start_odometer),0) s FROM routes WHERE user_id = ? ${vFilter} AND end_odometer IS NOT NULL`,
    user.id, ...vArgs
  )).s;

  const lastOdo = (await one(
    `SELECT max(odometer) o FROM (SELECT odometer FROM refuelings WHERE user_id = ? ${vFilter}
      UNION ALL SELECT odometer FROM readings WHERE user_id = ? ${vFilter}) sub`,
    user.id, ...vArgs, user.id, ...vArgs
  )).o;

  // last efficiency for the selected vehicle (or overall latest)
  const eff = vid
    ? await efficiencySeries(vid)
    : await (async () => {
        const first = await db.get('SELECT id FROM vehicles WHERE user_id = ? ORDER BY id LIMIT 1', user.id);
        return first ? await efficiencySeries(first.id) : [];
      })();
  const lastEff = eff.length ? eff[eff.length - 1] : null;

  const avgEff = eff.length
    ? Number((eff.reduce((a, b) => a + b.kmPerL, 0) / eff.length).toFixed(2))
    : null;
  const avgCostPerKm = eff.length
    ? Number((eff.reduce((a, b) => a + b.costPerKm, 0) / eff.length).toFixed(3))
    : null;

  // upcoming reminders
  const today = new Date().toISOString().slice(0, 10);
  const reminders = await db
    .prepare(
      `SELECT r.*, v.name AS vehicle_name FROM reminders r
         JOIN vehicles v ON v.id = r.vehicle_id
        WHERE r.user_id = ? AND r.active = 1
          AND ((r.kind = 'date' AND r.due_date IS NOT NULL AND r.due_date <= date('now','+30 day'))
            OR (r.kind = 'odometer' AND r.due_odometer IS NOT NULL AND r.due_odometer <= ?))
        ORDER BY CASE WHEN r.kind='date' THEN r.due_date ELSE '' END LIMIT 8`
    )
    .all(user.id, (lastOdo || 0) + 500);

  return sendJSON(res, 200, {
    counts: { refuelings: refuelCount, expenses: expenseCount, services: serviceCount, incomes: incomeCount },
    totals: {
      expenses: Number(expenseTotal.toFixed(2)),
      services: Number(serviceTotal.toFixed(2)),
      incomes: Number(incomeTotal.toFixed(2)),
      fuel: Number(fuelTotal.toFixed(2)),
      volume: Number(volumeTotal.toFixed(2)),
      km: Number(kmTotal.toFixed(1)),
      balance: Number((incomeTotal - expenseTotal - serviceTotal - fuelTotal).toFixed(2)),
    },
    odometer: lastOdo ? Number(lastOdo.toFixed(1)) : null,
    efficiency: { last: lastEff, average: avgEff, costPerKm: avgCostPerKm },
    reminders,
    today,
  });
});

// --- history (unified feed, mirrors ListagemDefault/Histórico) -------------
route('GET', '/api/history', async (req, res, params, body, user) => {
  const url = new URL(req.url, 'http://x');
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const types = (url.searchParams.get('types') || 'refueling,expense,service,income,route,reading').split(',');
  const vehicleId = url.searchParams.get('vehicle_id');
  const limit = Math.min(Number(url.searchParams.get('limit') || 200), 1000);

  const items = [];
  const push = (row, type, date, title, value, sub) => {
    if (vehicleId && String(row.vehicle_id) !== vehicleId) return;
    if (from && date < from) return;
    if (to && date > to) return;
    items.push({ type, id: row.id, date, title, value, sub, vehicle_id: row.vehicle_id, vehicle_name: row.vehicle_name });
  };

  if (types.includes('refueling')) {
    for (const r of await db.prepare(
      `SELECT r.*, v.name vehicle_name FROM refuelings r JOIN vehicles v ON v.id=r.vehicle_id
       WHERE r.user_id=? ORDER BY r.date DESC`
    ).all(user.id)) {
      push(r, 'refueling', r.date, r.station_name || 'Abastecimento', r.total,
        `${r.volume.toFixed(2)} L · R$ ${r.price.toFixed(2)}/L${r.full_tank ? ' · tanque cheio' : ''}`);
    }
  }
  if (types.includes('expense')) {
    for (const r of await db.prepare(
      `SELECT e.*, v.name vehicle_name, t.name type_name FROM expenses e
       JOIN vehicles v ON v.id=e.vehicle_id LEFT JOIN expense_types t ON t.id=e.expense_type_id
       WHERE e.user_id=? ORDER BY e.date DESC`
    ).all(user.id)) {
      push(r, 'expense', r.date, r.title, r.value - r.discount, r.type_name || 'Despesa');
    }
  }
  if (types.includes('service')) {
    for (const r of await db.prepare(
      `SELECT s.*, v.name vehicle_name, t.name type_name FROM services s
       JOIN vehicles v ON v.id=s.vehicle_id LEFT JOIN service_types t ON t.id=s.service_type_id
       WHERE s.user_id=? ORDER BY s.date DESC`
    ).all(user.id)) {
      push(r, 'service', r.date, r.title, r.value - r.discount, r.type_name || 'Serviço');
    }
  }
  if (types.includes('income')) {
    for (const r of await db.prepare(
      `SELECT i.*, v.name vehicle_name, t.name type_name FROM incomes i
       JOIN vehicles v ON v.id=i.vehicle_id LEFT JOIN income_types t ON t.id=i.income_type_id
       WHERE i.user_id=? ORDER BY i.date DESC`
    ).all(user.id)) {
      push(r, 'income', r.date, r.type_name || 'Receita', r.value, 'Receita');
    }
  }
  if (types.includes('route')) {
    for (const r of await db.prepare(
      `SELECT r.*, v.name vehicle_name FROM routes r JOIN vehicles v ON v.id=r.vehicle_id
       WHERE r.user_id=? ORDER BY r.start_date DESC`
    ).all(user.id)) {
      const dist = r.end_odometer != null ? r.end_odometer - r.start_odometer : null;
      push(r, 'route', r.start_date, 'Percurso', dist != null ? dist : null,
        dist != null ? `${dist.toFixed(0)} km` : 'Em andamento');
    }
  }
  if (types.includes('reading')) {
    for (const r of await db.prepare(
      `SELECT r.*, v.name vehicle_name FROM readings r JOIN vehicles v ON v.id=r.vehicle_id
       WHERE r.user_id=? ORDER BY r.date DESC`
    ).all(user.id)) {
      push(r, 'reading', r.date, 'Leitura do odômetro', r.odometer, 'Leitura');
    }
  }

  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const filtered = q
    ? items.filter((i) => (i.title || '').toLowerCase().includes(q) || (i.sub || '').toLowerCase().includes(q) || (i.vehicle_name || '').toLowerCase().includes(q))
    : items;
  return sendJSON(res, 200, filtered.slice(0, limit));
});

// --- reports ----------------------------------------------------------------
route('GET', '/api/reports', async (req, res, params, body, user) => {
  const url = new URL(req.url, 'http://x');
  const vehicleId = url.searchParams.get('vehicle_id');
  const range = periodRange(
    url.searchParams.get('period'),
    url.searchParams.get('from'),
    url.searchParams.get('to')
  );
  const vid = vehicleId ? Number(vehicleId) : null;
  const vFilter = vid ? 'AND vehicle_id = ?' : '';
  const vArgs = vid ? [vid] : [];
  // `routes` stores its date as start_date; everything else uses `date`.
  const dateFilter = (col = 'date') =>
    range.from ? `AND ${col} >= ? AND ${col} <= ?` : `AND ${col} <= ?`;
  const dateArgs = range.from ? [range.from, range.to] : [range.to];

  // monthly breakdown
  const monthly = await db
    .prepare(
      `SELECT ${ymExpr('date')} ym,
              coalesce(sum(value - discount),0) expenses
         FROM expenses WHERE user_id = ? ${vFilter} ${dateFilter()}
        GROUP BY ym ORDER BY ym`
    )
    .all(user.id, ...vArgs, ...dateArgs);

  const monthlyServices = await db
    .prepare(
      `SELECT ${ymExpr('date')} ym, coalesce(sum(value - discount),0) v
         FROM services WHERE user_id = ? ${vFilter} ${dateFilter()} GROUP BY ym`
    )
    .all(user.id, ...vArgs, ...dateArgs);

  const monthlyFuel = await db
    .prepare(
      `SELECT ${ymExpr('date')} ym, coalesce(sum(total - discount),0) v, coalesce(sum(volume),0) vol
         FROM refuelings WHERE user_id = ? ${vFilter} ${dateFilter()} GROUP BY ym`
    )
    .all(user.id, ...vArgs, ...dateArgs);

  const monthlyIncome = await db
    .prepare(
      `SELECT ${ymExpr('date')} ym, coalesce(sum(value),0) v
         FROM incomes WHERE user_id = ? ${vFilter} ${dateFilter()} GROUP BY ym`
    )
    .all(user.id, ...vArgs, ...dateArgs);

  const byType = await db
    .prepare(
      `SELECT coalesce(t.name,'Sem tipo') name, coalesce(sum(e.value - e.discount),0) value, count(*) n
         FROM expenses e LEFT JOIN expense_types t ON t.id = e.expense_type_id
        WHERE e.user_id = ? ${vFilter} ${dateFilter()}
        GROUP BY name ORDER BY value DESC`
    )
    .all(user.id, ...vArgs, ...dateArgs);

  const byServiceType = await db
    .prepare(
      `SELECT coalesce(t.name,'Sem tipo') name, coalesce(sum(s.value - s.discount),0) value, count(*) n
         FROM services s LEFT JOIN service_types t ON t.id = s.service_type_id
        WHERE s.user_id = ? ${vFilter} ${dateFilter()}
        GROUP BY name ORDER BY value DESC`
    )
    .all(user.id, ...vArgs, ...dateArgs);

  const byStation = await db
    .prepare(
      `SELECT coalesce(st.name,'Sem posto') name, coalesce(sum(r.total - r.discount),0) value,
              coalesce(sum(r.volume),0) volume, count(*) n
         FROM refuelings r LEFT JOIN stations st ON st.id = r.station_id
        WHERE r.user_id = ? ${vFilter} ${dateFilter()}
        GROUP BY name ORDER BY value DESC`
    )
    .all(user.id, ...vArgs, ...dateArgs);

  const priceHistory = await db
    .prepare(
      `SELECT date, price, volume, total, full_tank FROM refuelings
        WHERE user_id = ? ${vFilter} ${dateFilter()} ORDER BY date`
    )
    .all(user.id, ...vArgs, ...dateArgs);

  // With no vehicle selected, fall back to the primary vehicle so the
  // efficiency chart is never empty.
  const effVehicleId = vid
    || (await db.prepare('SELECT id FROM vehicles WHERE user_id = ? ORDER BY id LIMIT 1').get(user.id)?.id)
    || null;
  const odometerSeries = effVehicleId ? await efficiencySeries(effVehicleId) : [];

  // monthly distance from routes
  const monthlyKm = await db
    .prepare(
      `SELECT ${ymExpr('start_date')} ym, coalesce(sum(
              CASE WHEN end_odometer IS NOT NULL THEN end_odometer - start_odometer ELSE 0 END),0) km
         FROM routes WHERE user_id = ? ${vFilter} ${dateFilter('start_date')} GROUP BY ym ORDER BY ym`
    )
    .all(user.id, ...vArgs, ...dateArgs);

  return sendJSON(res, 200, {
    range,
    monthly,
    monthlyServices,
    monthlyFuel,
    monthlyIncome,
    monthlyKm,
    byType,
    byServiceType,
    byStation,
    priceHistory,
    efficiency: odometerSeries,
  });
});

// --- export CSV -------------------------------------------------------------
route('GET', '/api/export.csv', async (req, res, params, body, user) => {
  const url = new URL(req.url, 'http://x');
  const kind = url.searchParams.get('kind') || 'refuelings';
  const allowed = new Set(['refuelings', 'expenses', 'services', 'incomes', 'routes', 'readings']);
  if (!allowed.has(kind)) return sendJSON(res, 400, { error: 'Tipo inválido.' });

  const queries = {
    refuelings: `SELECT r.date Data, v.name Veiculo, r.odometer Odometro, r.price Preco, r.volume Volume,
                        r.total Total, r.full_tank TanqueCheio, f.name Combustivel, s.name Posto,
                        p.name FormaPagamento, d.name Motorista, r.notes Observacao
                   FROM refuelings r JOIN vehicles v ON v.id=r.vehicle_id
                   LEFT JOIN fuels f ON f.id=r.fuel_id LEFT JOIN stations s ON s.id=r.station_id
                   LEFT JOIN payment_methods p ON p.id=r.payment_id LEFT JOIN drivers d ON d.id=r.driver_id
                  WHERE r.user_id=? ORDER BY r.date`,
    expenses: `SELECT e.date Data, v.name Veiculo, e.title Titulo, e.value Valor, e.discount Desconto,
                      e.installments Parcelas, t.name Tipo, p.name FormaPagamento, l.name Local, e.notes Observacao
                 FROM expenses e JOIN vehicles v ON v.id=e.vehicle_id
                 LEFT JOIN expense_types t ON t.id=e.expense_type_id
                 LEFT JOIN payment_methods p ON p.id=e.payment_id LEFT JOIN places l ON l.id=e.place_id
                WHERE e.user_id=? ORDER BY e.date`,
    services: `SELECT s.date Data, v.name Veiculo, s.title Titulo, s.value Valor, s.discount Desconto,
                      t.name Tipo, p.name FormaPagamento, l.name Local, s.notes Observacao
                 FROM services s JOIN vehicles v ON v.id=s.vehicle_id
                 LEFT JOIN service_types t ON t.id=s.service_type_id
                 LEFT JOIN payment_methods p ON p.id=s.payment_id LEFT JOIN places l ON l.id=s.place_id
                WHERE s.user_id=? ORDER BY s.date`,
    incomes: `SELECT i.date Data, v.name Veiculo, i.value Valor, t.name Tipo, i.notes Observacao
                FROM incomes i JOIN vehicles v ON v.id=i.vehicle_id
                LEFT JOIN income_types t ON t.id=i.income_type_id
               WHERE i.user_id=? ORDER BY i.date`,
    routes: `SELECT r.start_date Data, v.name Veiculo, o.name Origem, d2.name Destino,
                    r.start_odometer OdometroInicial, r.end_odometer OdometroFinal,
                    (r.end_odometer-r.start_odometer) Distancia, r.freight_value Frete
               FROM routes r JOIN vehicles v ON v.id=r.vehicle_id
               LEFT JOIN places o ON o.id=r.origin_id LEFT JOIN places d2 ON d2.id=r.destination_id
              WHERE r.user_id=? ORDER BY r.start_date`,
    readings: `SELECT rd.date Data, v.name Veiculo, rd.odometer Odometro, rd.notes Observacao
                 FROM readings rd JOIN vehicles v ON v.id=rd.vehicle_id
                WHERE rd.user_id=? ORDER BY rd.date`,
  };
  const rows = await db.prepare(queries[kind]).all(user.id);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const headers = rows.length ? Object.keys(rows[0]) : ['vazio'];
  const csv = '﻿' + [headers.join(';'), ...rows.map((r) => headers.map((h) => esc(r[h])).join(';'))].join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="carango-${kind}.csv"`,
  });
  res.end(csv);
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname.startsWith('/api/')) {
    const match = routes.find((r) => r.method === req.method && r.rx.test(url.pathname));
    if (!match) return sendJSON(res, 404, { error: 'Rota não encontrada.' });

    const m = url.pathname.match(match.rx);
    const params = {};
    match.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));

    let user = null;
    if (match.auth) {
      const userId = await getSession(req);
      if (!userId) return sendJSON(res, 401, { error: 'Não autenticado.' });
      user = await db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId);
      if (!user) return sendJSON(res, 401, { error: 'Não autenticado.' });
    }

    try {
      const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
      await match.handler(req, res, params, body, user);
    } catch (e) {
      console.error(`[api] ${req.method} ${url.pathname}:`, e);
      if (!res.headersSent) sendJSON(res, 500, { error: 'Erro interno do servidor.' });
    }
    return;
  }

  // static files
  let filePath = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, st) => {
    if (err || st.isDirectory()) filePath = path.join(PUBLIC, 'index.html');
    fs.readFile(filePath, (err2, data) => {
      if (err2) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Não encontrado');
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(data);
    });
  });
});

init().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Carango web em http://0.0.0.0:${PORT} [db=${db.driver}]`);
    console.log('Conta demo: demo@carango.app / carango123');
  });
}).catch((err) => {
  console.error('Falha ao iniciar banco:', err);
  process.exit(1);
});
