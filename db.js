'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

// tiny .env loader (no dependency)
(() => {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch {}
})();

let _pool = null;

function normalizeRunResult(result) {
  return { lastInsertRowid: Number(result.insertId || 0), changes: Number(result.affectedRows || 0) };
}

const db = {
  prepare(sql) {
    return {
      get: (...args) => db.get(sql, ...args),
      all: (...args) => db.all(sql, ...args),
      run: (...args) => db.run(sql, ...args),
    };
  },
  async get(sql, ...args) {
    const [rows] = await _pool.execute(sql, args);
    return rows[0] || undefined;
  },
  async all(sql, ...args) {
    const [rows] = await _pool.execute(sql, args);
    return rows;
  },
  async run(sql, ...args) {
    const [result] = await _pool.execute(sql, args);
    return normalizeRunResult(result);
  },
  async exec(sql) {
    const statements = sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
    for (const st of statements) await _pool.query(st);
  },
};

function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || String(v).trim() === '') {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return String(v);
}

async function init() {
  const missing = ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE']
    .filter((k) => process.env[k] === undefined || String(process.env[k]).trim() === '');
  if (missing.length) {
    throw new Error(`Credenciais MySQL ausentes no ambiente: ${missing.join(', ')}. Configure o .env.`);
  }

  const host = requireEnv('MYSQL_HOST');
  const port = Number(requireEnv('MYSQL_PORT'));
  const user = requireEnv('MYSQL_USER');
  const password = process.env.MYSQL_PASSWORD;
  const database = requireEnv('MYSQL_DATABASE');

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`MYSQL_PORT inválido: ${process.env.MYSQL_PORT}`);
  }

  // ensure database exists
  const admin = await mysql.createConnection({ host, port, user, password, multipleStatements: true });
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();

  _pool = mysql.createPool({
    host, port, user, password, database,
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
    decimalNumbers: true,
    dateStrings: true,
  });

  await ensureSchema();
  await seedIfEmpty();
}

/* ---------- schema ---------- */
async function ensureSchema() {
  const q = async (sql) => { await _pool.query(sql); };
  await q(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL, salt VARCHAR(255) NOT NULL, quick_token VARCHAR(255),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await q(`CREATE TABLE IF NOT EXISTS vehicles (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, name VARCHAR(255) NOT NULL, brand VARCHAR(255), model VARCHAR(255),
    year INT, plate VARCHAR(50), fuel_type VARCHAR(50) NOT NULL DEFAULT 'Gasolina', tank_volume DOUBLE NOT NULL DEFAULT 50,
    odometer_unit INT NOT NULL DEFAULT 1, active TINYINT NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_veh_user (user_id), CONSTRAINT fk_veh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const simple = async (name) => q(`CREATE TABLE IF NOT EXISTS ${name} (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, name VARCHAR(255) NOT NULL,
    ${name === 'stations' || name === 'places' ? 'address VARCHAR(255),' : ''} active TINYINT NOT NULL DEFAULT 1,
    INDEX idx_${name}_user (user_id), CONSTRAINT fk_${name}_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  for (const t of ['fuels', 'stations', 'places', 'payment_methods', 'expense_types', 'service_types', 'income_types', 'reason_types', 'drivers']) await simple(t);

  await q(`CREATE TABLE IF NOT EXISTS refuelings (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, vehicle_id INT NOT NULL, date DATE NOT NULL, odometer DOUBLE NOT NULL,
    price DOUBLE NOT NULL DEFAULT 0, volume DOUBLE NOT NULL DEFAULT 0, total DOUBLE NOT NULL DEFAULT 0, full_tank TINYINT NOT NULL DEFAULT 0,
    discount DOUBLE NOT NULL DEFAULT 0, fuel_id INT, station_id INT, payment_id INT, driver_id INT, reason_id INT, notes TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ref_user (user_id), INDEX idx_ref_veh (vehicle_id,date),
    CONSTRAINT fk_ref_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_ref_veh FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await q(`CREATE TABLE IF NOT EXISTS expenses (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, vehicle_id INT NOT NULL, date DATE NOT NULL, odometer DOUBLE,
    title VARCHAR(255) NOT NULL, value DOUBLE NOT NULL DEFAULT 0, discount DOUBLE NOT NULL DEFAULT 0, installments INT NOT NULL DEFAULT 1,
    expense_type_id INT, payment_id INT, place_id INT, driver_id INT, reason_id INT, notes TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_exp_user (user_id), INDEX idx_exp_veh (vehicle_id,date),
    CONSTRAINT fk_exp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_exp_veh FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await q(`CREATE TABLE IF NOT EXISTS services (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, vehicle_id INT NOT NULL, date DATE NOT NULL, odometer DOUBLE,
    title VARCHAR(255) NOT NULL, value DOUBLE NOT NULL DEFAULT 0, discount DOUBLE NOT NULL DEFAULT 0, installments INT NOT NULL DEFAULT 1,
    service_type_id INT, payment_id INT, place_id INT, driver_id INT, reason_id INT, notes TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_srv_user (user_id), INDEX idx_srv_veh (vehicle_id,date),
    CONSTRAINT fk_srv_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_srv_veh FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await q(`CREATE TABLE IF NOT EXISTS incomes (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, vehicle_id INT NOT NULL, date DATE NOT NULL, odometer DOUBLE,
    value DOUBLE NOT NULL DEFAULT 0, installments INT NOT NULL DEFAULT 1, income_type_id INT, notes TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_inc_user (user_id), INDEX idx_inc_veh (vehicle_id,date),
    CONSTRAINT fk_inc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_inc_veh FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await q(`CREATE TABLE IF NOT EXISTS routes (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, vehicle_id INT NOT NULL, origin_id INT, destination_id INT,
    start_date DATE NOT NULL, end_date DATE, start_odometer DOUBLE NOT NULL, end_odometer DOUBLE,
    distance_value DOUBLE NOT NULL DEFAULT 0, freight_value DOUBLE NOT NULL DEFAULT 0, driver_id INT, reason_id INT, notes TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_route_user (user_id), INDEX idx_route_veh (vehicle_id,start_date),
    CONSTRAINT fk_route_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_route_veh FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await q(`CREATE TABLE IF NOT EXISTS readings (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, vehicle_id INT NOT NULL, date DATE NOT NULL, odometer DOUBLE NOT NULL, notes TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_read_user (user_id), INDEX idx_read_veh (vehicle_id,date),
    CONSTRAINT fk_read_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_read_veh FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await q(`CREATE TABLE IF NOT EXISTS reminders (
    id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, vehicle_id INT NOT NULL, kind VARCHAR(20) NOT NULL DEFAULT 'date',
    title VARCHAR(255) NOT NULL, due_date DATE, due_odometer DOUBLE, repeat_days INT, repeat_km DOUBLE, notes TEXT, active TINYINT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_rem_user (user_id), INDEX idx_rem_veh (vehicle_id),
    CONSTRAINT fk_rem_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_rem_veh FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await q(`CREATE TABLE IF NOT EXISTS sessions (
    sid VARCHAR(64) PRIMARY KEY, user_id INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sess_user (user_id),
    CONSTRAINT fk_sess_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  try { await _pool.query("ALTER TABLE users ADD COLUMN quick_token VARCHAR(255)"); } catch {}
}

/* ---------- auth helpers ---------- */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

async function createUser(name, email, password) {
  const { salt, hash } = hashPassword(password);
  const result = await db.run(
    'INSERT INTO users (name, email, password_hash, salt) VALUES (?, ?, ?, ?)',
    String(name).trim(), String(email).trim().toLowerCase(), hash, salt
  );
  const userId = result.lastInsertRowid;
  await seedDemoForUser(userId);
  return userId;
}

async function verifyUser(email, password) {
  const row = await db.get('SELECT * FROM users WHERE email = ?', String(email).trim().toLowerCase());
  if (!row) return null;
  const { hash } = hashPassword(password, row.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(row.password_hash, 'hex'))) return null;
  return { id: row.id, name: row.name, email: row.email };
}

/* ---------- seed ---------- */
async function seedIfEmpty() {
  const row = await db.get('SELECT COUNT(*) AS c FROM users');
  if (Number(row.c) > 0) return;
  const { salt, hash } = hashPassword('carango123');
  const r = await db.run(
    'INSERT INTO users (name, email, password_hash, salt) VALUES (?, ?, ?, ?)',
    'Demonstração', 'demo@carango.app', hash, salt
  );
  await seedDemoForUser(r.lastInsertRowid);
}

async function seedDemoForUser(userId) {
  // simplified seed: create 2 vehicles and a few records; full demo is nice but not essential
  const ins = async (sql, ...args) => (await db.run(sql, ...args)).lastInsertRowid;
  const v1 = await ins(`INSERT INTO vehicles (user_id,name,brand,model,year,plate,fuel_type,tank_volume) VALUES (?,?,?,?,?,?,?,?)`,
    userId, 'Gol', 'Volkswagen', 'Gol 1.6 MSI', 2019, 'ABC1D23', 'Gasolina', 52);
  await ins(`INSERT INTO vehicles (user_id,name,brand,model,year,plate,fuel_type,tank_volume) VALUES (?,?,?,?,?,?,?,?)`,
    userId, 'Hilux', 'Toyota', 'Hilux SW4 2.8', 2021, 'DEF4G56', 'Diesel', 80);
  const fuel = await ins('INSERT INTO fuels (user_id,name) VALUES (?,?)', userId, 'Gasolina Comum');
  const station = await ins('INSERT INTO stations (user_id,name) VALUES (?,?)', userId, 'Shell Centro');
  const pm = await ins('INSERT INTO payment_methods (user_id,name) VALUES (?,?)', userId, 'Cartão');
  await ins('INSERT INTO expense_types (user_id,name) VALUES (?,?)', userId, 'Pedágio');
  await ins('INSERT INTO service_types (user_id,name) VALUES (?,?)', userId, 'Troca de óleo');
  await ins('INSERT INTO income_types (user_id,name) VALUES (?,?)', userId, 'Frete');
  await ins('INSERT INTO places (user_id,name) VALUES (?,?)', userId, 'Casa');
  await ins('INSERT INTO places (user_id,name) VALUES (?,?)', userId, 'Trabalho');

  const today = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i * 7);
    const date = d.toISOString().slice(0, 10);
    const odo = 60000 + (5 - i) * 350;
    const vol = 38 + i; const price = 5.79 + i * 0.02; const total = Number((vol * price).toFixed(2));
    await ins(`INSERT INTO refuelings (user_id,vehicle_id,date,odometer,price,volume,total,full_tank,fuel_id,station_id,payment_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      userId, v1, date, odo, price, vol, total, 1, fuel, station, pm);
  }
  await ins(`INSERT INTO expenses (user_id,vehicle_id,date,odometer,title,value,expense_type_id,payment_id) VALUES (?,?,?,?,?,?,?,?)`,
    userId, v1, today.toISOString().slice(0, 10), 61750, 'Pedágio', 35, 1, pm);
  await ins(`INSERT INTO services (user_id,vehicle_id,date,odometer,title,value,service_type_id) VALUES (?,?,?,?,?,?,?)`,
    userId, v1, today.toISOString().slice(0, 10), 61500, 'Troca de óleo', 280, 1);
  await ins(`INSERT INTO reminders (user_id,vehicle_id,kind,title,due_date,repeat_days) VALUES (?,?,?,?,?,?)`,
    userId, v1, 'date', 'Troca de óleo', new Date(today.getFullYear(), today.getMonth() + 3, today.getDate()).toISOString().slice(0, 10), 180);
}

module.exports = { db, init, createUser, verifyUser, hashPassword };
