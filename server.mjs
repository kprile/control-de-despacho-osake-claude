// Servidor del piloto de despachos (Osake, Melipilla). Especificación: docs/CONTRATO.md
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import QRCode from 'qrcode';
import { createSheetsSync } from './sheets.mjs';

// node:sqlite emite un ExperimentalWarning en Node 22; lo silenciamos solo a él.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  const msg = typeof warning === 'string' ? warning : warning?.message;
  const isExperimental = type === 'ExperimentalWarning' || warning?.name === 'ExperimentalWarning';
  if (isExperimental && /sqlite/i.test(msg || '')) return;
  return originalEmitWarning.call(process, warning, ...args);
};
const { DatabaseSync } = await import('node:sqlite');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TZ = 'America/Santiago';
const BODY_LIMIT = 256 * 1024;
const ROLES = ['admin', 'local', 'driver'];
const CHANNELS = ['meson', 'telefono', 'mercat', 'otro'];
const ACTIVE_STATUSES = ['preparing', 'ready', 'in_transit'];
const DEFAULT_BRANCH = 'Melipilla';
const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const scrypt = promisify(crypto.scrypt);

// ---------- Configuración ----------

export function loadDotEnv(file = path.join(ROOT, '.env'), target = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in target)) target[key] = value;
  }
}

function buildConfig(env) {
  const origins = String(env.PUBLIC_ORIGIN || 'http://127.0.0.1:4317')
    .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)
    // Normaliza mayúsculas y puerto por defecto, como lo envía el navegador en Origin.
    .map((s) => { try { const u = new URL(s); return u.origin === 'null' ? s : u.origin; } catch { return s; } });
  const days = Number(env.SESSION_DAYS);
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT) || 4317,
    origins,
    secureCookie: (origins[0] || '').startsWith('https://'),
    setupToken: env.SETUP_TOKEN || '',
    webhookSecret: env.MERCAT_WEBHOOK_SECRET || '',
    dbPath: env.DB_PATH === ':memory:' ? ':memory:' : path.resolve(ROOT, env.DB_PATH || 'data/despachos.sqlite'),
    sessionDays: Number.isFinite(days) && days > 0 ? days : 14,
  };
}

// ---------- Utilidades de fecha (hora Chile) ----------

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function chileParts(date) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(date)) p[type] = value;
  return p;
}
function chileDay(value) {
  const p = chileParts(new Date(value));
  return `${p.year}-${p.month}-${p.day}`;
}
function chileMonth(value) { return chileDay(value).slice(0, 7); }
function chileDateTime(value) {
  if (!value) return '';
  const p = chileParts(new Date(value));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
function tzOffsetMs(ms) {
  const p = chileParts(new Date(ms));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function isValidDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const isValidMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

// Fecha de Mercat: ISO con zona, epoch (s o ms) o "YYYY-MM-DD HH:MM[:SS]" sin zona (se asume hora Chile).
function parseExternalTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{9,13}$/.test(value.trim()))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  if (typeof value !== 'string' || value.length > 64) return null;
  const s = value.trim();
  const local = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
  if (local) {
    const [, y, mo, d, h, mi, se] = local.map((x) => (x === undefined ? '0' : x));
    const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
    const offA = tzOffsetMs(wall);
    const offB = tzOffsetMs(wall - offA);
    let utc = wall - offB;
    // Hora inexistente (salto de horario de verano, p. ej. 00:30 del primer domingo de septiembre):
    // ningún desfase es estable; se usa el anterior al cambio, que la lleva hacia adelante (01:30).
    if (utc + tzOffsetMs(utc) !== wall) utc = wall - Math.min(offA, offB);
    return Number.isFinite(utc) ? utc : null;
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

const nowIso = () => new Date().toISOString();

// ---------- Errores y validación ----------

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const bad = (message) => new HttpError(400, 'bad_request', message);
const forbidden = (message = 'No tienes permiso para esta acción.') => new HttpError(403, 'forbidden', message);
const notFound = (message = 'No encontrado.') => new HttpError(404, 'not_found', message);
const conflict = (message) => new HttpError(409, 'invalid_transition', message);

function optText(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw bad(`${label} debe ser texto.`);
  const s = String(value).trim();
  if (s.length > max) throw bad(`${label} supera ${max} caracteres.`);
  return s;
}
function reqText(value, max, label) {
  const s = optText(value, max, label);
  if (!s) throw bad(`${label} es obligatorio.`);
  return s;
}
function optMoney(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 0 || n > 1e10) throw bad(`${label} debe ser un entero mayor o igual a 0.`);
  return n;
}
function optCoord(value, min, max, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw bad(`${label} fuera de rango.`);
  return n;
}
function optId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n <= 0) throw bad(`${label} inválido.`);
  return n;
}
function trunc(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}
function normalizeOrderId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw bad('orderId es obligatorio.');
  let s = String(value).trim();
  if (/^DESPACHO:/i.test(s)) s = s.slice(9).trim();
  s = s.toUpperCase();
  if (!/^P-\d{1,12}$/.test(s)) throw notFound('Pedido no encontrado.');
  return s;
}

// ---------- Contraseñas ----------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return { salt: salt.toString('base64'), hash: Buffer.from(hash).toString('base64') };
}
async function verifyPassword(password, saltB64, hashB64) {
  const expected = Buffer.from(hashB64, 'base64');
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 6) throw bad('La contraseña debe tener al menos 6 caracteres.');
  if (p.length > 200) throw bad('La contraseña es demasiado larga.');
  return p;
}
function validateUsername(u) {
  if (typeof u !== 'string') throw bad('Usuario es obligatorio.');
  const s = u.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(s)) throw bad('Usuario inválido: 3 a 40 caracteres (letras, números, punto, guion).');
  return s;
}

// ---------- Base de datos ----------

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL CHECK (role IN ('admin','local','driver')),
      pass_salt TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS orders (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE,
      source TEXT NOT NULL,
      external_id TEXT UNIQUE,
      channel TEXT NOT NULL,
      branch TEXT NOT NULL,
      customer_name TEXT NOT NULL DEFAULT '',
      customer_phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      address_detail TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      lat REAL, lng REAL,
      delivery_fee INTEGER, total INTEGER,
      items_json TEXT NOT NULL DEFAULT '[]',
      promised_at TEXT,
      status TEXT NOT NULL,
      external_status TEXT,
      pickup INTEGER NOT NULL DEFAULT 0,
      driver_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      ready_at TEXT, departed_at TEXT, delivered_at TEXT,
      delivery_lat REAL, delivery_lng REAL, delivery_accuracy REAL,
      external_ts INTEGER,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);
    CREATE INDEX IF NOT EXISTS orders_delivered ON orders(delivered_at);
    CREATE INDEX IF NOT EXISTS orders_driver ON orders(driver_id);
    CREATE TABLE IF NOT EXISTS order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      at TEXT NOT NULL,
      user_id INTEGER,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      note TEXT,
      data_json TEXT
    );
    CREATE INDEX IF NOT EXISTS order_events_order ON order_events(order_id);
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL,
      event_type TEXT,
      event_ts INTEGER,
      external_id TEXT,
      applied INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS monthly_costs (
      month TEXT PRIMARY KEY,
      labor INTEGER NOT NULL DEFAULT 0,
      fuel INTEGER NOT NULL DEFAULT 0,
      maintenance INTEGER NOT NULL DEFAULT 0,
      insurance INTEGER NOT NULL DEFAULT 0,
      other INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by INTEGER
    );
  `);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- HTTP helpers ----------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body) || typeof body === 'string';
  const payload = isBuffer ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > BODY_LIMIT) {
      req.resume();
      return reject(new HttpError(413, 'payload_too_large', 'El cuerpo de la solicitud es demasiado grande.'));
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        done = true;
        req.resume();
        return reject(new HttpError(413, 'payload_too_large', 'El cuerpo de la solicitud es demasiado grande.'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('no objeto');
        resolve(parsed);
      } catch {
        reject(bad('JSON inválido.'));
      }
    });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function escapeXml(s) {
  return String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function wrapText(text, max, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (let w of words) {
    while (w.length > max) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, max));
      w = w.slice(max);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= max) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].slice(0, max - 1) + '…';
    return kept;
  }
  return lines;
}

function buildLabelSvg(order) {
  const qr = QRCode.create(`DESPACHO:${order.id}`, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const margin = 2;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.modules.data[y * n + x]) d += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }
  const W = 400;
  const qrSize = 320;
  const lines = [];
  let y = qrSize + 40 + 36;
  lines.push(`<text x="${W / 2}" y="${y}" font-size="36" font-weight="bold" text-anchor="middle">${escapeXml(order.id)}</text>`);
  y += 8;
  const add = (text, size, weight = 'normal', max = 32, maxLines = 2) => {
    for (const line of wrapText(text, max, maxLines)) {
      y += size + 6;
      lines.push(`<text x="20" y="${y}" font-size="${size}" font-weight="${weight}">${escapeXml(line)}</text>`);
    }
  };
  if (order.customerName) add(order.customerName, 22, 'bold', 28, 2);
  if (order.address) add(order.address, 20, 'normal', 32, 4);
  if (order.addressDetail) add(order.addressDetail, 18, 'normal', 36, 2);
  if (order.pickup) add('RETIRO EN LOCAL', 18, 'bold');
  const H = y + 24;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Arial, Helvetica, sans-serif">
<rect width="${W}" height="${H}" fill="#fff"/>
<svg x="${(W - qrSize) / 2}" y="20" width="${qrSize}" height="${qrSize}" viewBox="0 0 ${n + margin * 2} ${n + margin * 2}" shape-rendering="crispEdges"><path fill="#000" d="${d}"/></svg>
<g fill="#000">${lines.join('')}</g>
</svg>`;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- Métricas ----------

const minutesBetween = (a, b) => {
  if (!a || !b) return null;
  const diff = (Date.parse(b) - Date.parse(a)) / 60000;
  return Number.isFinite(diff) && diff >= 0 ? diff : null;
};
const round1 = (n) => Math.round(n * 10) / 10;
function avgOf(values) {
  const v = values.filter((x) => x !== null);
  return { avgMinutes: v.length ? round1(v.reduce((s, x) => s + x, 0) / v.length) : null, count: v.length };
}
function intervals(o) {
  return {
    prep: minutesBetween(o.created_at, o.ready_at),
    wait: minutesBetween(o.ready_at, o.departed_at),
    route: o.status === 'delivered' ? minutesBetween(o.departed_at, o.delivered_at) : null,
    total: o.status === 'delivered' ? minutesBetween(o.created_at, o.delivered_at) : null,
  };
}

// ---------- Aplicación ----------

export function createApp({ dbPath, env = process.env, publicDir = path.join(ROOT, 'public') } = {}) {
  const config = buildConfig(env);
  const db = openDb(dbPath || config.dbPath);
  const loginAttempts = new Map();
  // Copia de solo lectura a Google Sheets; se marca "sucia" en logEvent (todo cambio de pedido) y al guardar costos.
  const sheets = createSheetsSync({ env, getSnapshot: (days) => sheetsSnapshot(days) });

  const q = {
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    insertUser: db.prepare('INSERT INTO users (name, username, role, pass_salt, pass_hash, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?) RETURNING id'),
    sessionUser: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
    deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    orderById: db.prepare('SELECT o.*, u.name AS driver_name FROM orders o LEFT JOIN users u ON u.id = o.driver_id WHERE o.id = ?'),
    orderByExternal: db.prepare('SELECT * FROM orders WHERE external_id = ?'),
    insertEvent: db.prepare('INSERT INTO order_events (order_id, at, user_id, actor, action, from_status, to_status, note, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    costsByMonth: db.prepare('SELECT * FROM monthly_costs WHERE month = ?'),
  };

  // ----- sesiones -----
  const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');
  // Secure según el origen (ya validado) desde el que llegó la solicitud: con varios PUBLIC_ORIGIN
  // (p. ej. emulador http + producción https) la cookie emitida vía https siempre lleva Secure.
  function cookieHeader(value, maxAge, req) {
    const secure = req?.allowedOrigin ? req.allowedOrigin.startsWith('https://') : config.secureCookie;
    return `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }
  function createSession(userId, req) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    q.deleteExpired.run(new Date(now).toISOString());
    q.insertSession.run(tokenHash(token), userId, new Date(now).toISOString(),
      new Date(now + config.sessionDays * 86400000).toISOString());
    return cookieHeader(token, Math.round(config.sessionDays * 86400), req);
  }
  function currentSession(req) {
    const token = parseCookies(req.headers.cookie).sid;
    if (!token || token.length > 100) return null;
    const user = q.sessionUser.get(tokenHash(token), nowIso());
    return user ? { user, tokenHash: tokenHash(token) } : null;
  }
  const publicUser = (u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: !!u.active, createdAt: u.created_at });

  function requireUser(req, roles) {
    const s = currentSession(req);
    if (!s) throw new HttpError(401, 'unauthorized', 'Debes iniciar sesión.');
    if (roles && !roles.includes(s.user.role)) throw forbidden();
    return s;
  }

  function checkOrigin(req) {
    let origin = req.headers.origin;
    if (!origin && req.headers.referer) {
      try { origin = new URL(req.headers.referer).origin; } catch { origin = ''; }
    }
    if (!origin || origin === 'null' || !config.origins.includes(origin.replace(/\/+$/, ''))) {
      throw new HttpError(403, 'bad_origin', 'Origen de la solicitud no permitido.');
    }
    req.allowedOrigin = origin.replace(/\/+$/, '');
  }

  // ----- pedidos -----
  function incidentsFor(ids) {
    const map = new Map();
    if (!ids.length) return map;
    const rows = db.prepare(`SELECT order_id, at, actor, note, action FROM order_events
      WHERE action IN ('incident','fail') AND order_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
    for (const r of rows) {
      if (!map.has(r.order_id)) map.set(r.order_id, []);
      map.get(r.order_id).push({ at: r.at, by: r.actor, note: r.action === 'fail' ? `No entregado: ${r.note}` : r.note });
    }
    return map;
  }
  function toOrder(o, incidents, role) {
    let items = [];
    try { items = JSON.parse(o.items_json); } catch { /* items corruptos */ }
    const out = {
      id: o.id, source: o.source, externalId: o.external_id, channel: o.channel, branch: o.branch,
      customerName: o.customer_name, customerPhone: o.customer_phone,
      address: o.address, addressDetail: o.address_detail, notes: o.notes,
      lat: o.lat, lng: o.lng, deliveryFee: o.delivery_fee, total: o.total, items,
      promisedAt: o.promised_at, status: o.status, externalStatus: o.external_status, pickup: !!o.pickup,
      driverId: o.driver_id, driverName: o.driver_name ?? null,
      createdAt: o.created_at, readyAt: o.ready_at, departedAt: o.departed_at, deliveredAt: o.delivered_at,
      deliveryLat: o.delivery_lat, deliveryLng: o.delivery_lng, deliveryAccuracy: o.delivery_accuracy,
      incidents: incidents.get(o.id) || [],
    };
    if (role === 'driver') delete out.total;
    return out;
  }
  function loadOrder(id, role) {
    const row = q.orderById.get(id);
    return row ? toOrder(row, incidentsFor([id]), role) : null;
  }
  // Busca un pedido visible para el usuario; para motoristas los ajenos "no existen".
  function findAccessibleOrder(orderId, user) {
    const id = normalizeOrderId(orderId);
    const row = q.orderById.get(id);
    if (!row || (user.role === 'driver' && row.driver_id !== user.id)) throw notFound('Pedido no encontrado.');
    return row;
  }
  function insertOrder(fields) {
    const cols = Object.keys(fields);
    const row = db.prepare(`INSERT INTO orders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING seq`)
      .get(...cols.map((c) => fields[c]));
    const id = `P-${row.seq + 1000}`;
    db.prepare('UPDATE orders SET id = ? WHERE seq = ?').run(id, row.seq);
    return id;
  }
  function updateOrder(id, fields) {
    const cols = Object.keys(fields);
    db.prepare(`UPDATE orders SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => fields[c]), id);
  }
  function logEvent(orderId, user, action, from, to, note = null, data = null) {
    sheets.markDirty();
    q.insertEvent.run(orderId, nowIso(), user?.id ?? null, user?.name ?? 'Mercat', action, from, to, note,
      data ? JSON.stringify(data) : null);
  }

  function parseItems(items) {
    if (items === undefined || items === null) return [];
    if (!Array.isArray(items)) throw bad('items debe ser una lista.');
    if (items.length > 100) throw bad('Demasiados productos.');
    return items.map((it, i) => {
      if (!it || typeof it !== 'object') throw bad(`Producto ${i + 1} inválido.`);
      const name = reqText(it.name, 120, `Nombre del producto ${i + 1}`);
      const qty = it.qty === undefined || it.qty === null || it.qty === '' ? 1 : Number(it.qty);
      if (!Number.isSafeInteger(qty) || qty < 1 || qty > 999) throw bad(`Cantidad del producto ${i + 1} inválida.`);
      return { name, qty };
    });
  }

  function createManualOrder(body, user) {
    const channel = body.channel === undefined || body.channel === null || body.channel === '' ? 'meson' : body.channel;
    if (!CHANNELS.includes(channel)) throw bad('Canal inválido.');
    let promisedAt = null;
    if (body.promisedAt !== undefined && body.promisedAt !== null && body.promisedAt !== '') {
      const ms = parseExternalTime(body.promisedAt);
      if (ms === null) throw bad('promisedAt inválido.');
      promisedAt = new Date(ms).toISOString();
    }
    const now = nowIso();
    const fields = {
      source: 'manual', external_id: null, channel,
      branch: optText(body.branch, 60, 'Sucursal') || DEFAULT_BRANCH,
      customer_name: optText(body.customerName, 120, 'Nombre del cliente'),
      customer_phone: optText(body.customerPhone, 40, 'Teléfono'),
      address: reqText(body.address, 300, 'Dirección'),
      address_detail: optText(body.addressDetail, 200, 'Detalle de dirección'),
      notes: optText(body.notes, 1000, 'Notas'),
      lat: optCoord(body.lat, -90, 90, 'Latitud'),
      lng: optCoord(body.lng, -180, 180, 'Longitud'),
      delivery_fee: optMoney(body.deliveryFee, 'Tarifa de despacho'),
      total: optMoney(body.total, 'Total'),
      items_json: JSON.stringify(parseItems(body.items)),
      promised_at: promisedAt, status: 'preparing', pickup: 0,
      created_at: now, updated_at: now,
    };
    return tx(db, () => {
      const id = insertOrder(fields);
      logEvent(id, user, 'create', null, 'preparing');
      return id;
    });
  }

  const ACTION_ROLES = {
    ready: ['admin', 'local'],
    assign: ['admin', 'local'],
    depart: ['admin', 'local', 'driver'],
    deliver: ['admin', 'driver'],
    incident: ['admin', 'local', 'driver'],
    fail: ['admin', 'driver'],
    cancel: ['admin', 'local'],
  };

  function applyAction(body, user) {
    const action = body.action;
    if (typeof action !== 'string' || !ACTION_ROLES[action]) throw bad('Acción inválida.');
    return tx(db, () => {
      const o = findAccessibleOrder(body.orderId, user);
      if (!ACTION_ROLES[action].includes(user.role)) throw forbidden();
      const now = nowIso();
      const st = o.status;
      const need = (ok, msg) => { if (!ok) throw conflict(msg); };
      switch (action) {
        case 'ready':
          need(st === 'preparing', 'Solo un pedido en preparación puede marcarse listo.');
          updateOrder(o.id, { status: 'ready', ready_at: now, updated_at: now });
          logEvent(o.id, user, action, st, 'ready');
          break;
        case 'assign': {
          const driverId = optId(body.driverId, 'Motorista');
          if (!driverId) throw bad('Debes indicar el motorista.');
          need(!o.pickup, 'Un pedido de retiro no se asigna a motorista.');
          need(st === 'preparing' || st === 'ready', 'Solo se asigna un pedido en preparación o listo.');
          const d = q.userById.get(driverId);
          if (!d || d.role !== 'driver' || !d.active) throw bad('Motorista inválido o inactivo.');
          updateOrder(o.id, { driver_id: driverId, updated_at: now });
          logEvent(o.id, user, action, st, st, null, { driverId, previous: o.driver_id });
          break;
        }
        case 'depart':
          need(!o.pickup, 'Un pedido de retiro no se despacha.');
          need(st === 'ready', 'Solo un pedido listo puede salir.');
          need(!!o.driver_id, 'El pedido no tiene motorista asignado.');
          updateOrder(o.id, { status: 'in_transit', departed_at: now, updated_at: now });
          logEvent(o.id, user, action, st, 'in_transit');
          break;
        case 'deliver': {
          need(st === 'in_transit', st === 'delivered' ? 'El pedido ya fue entregado.' : 'Solo un pedido en ruta puede entregarse.');
          const lat = optCoord(body.lat, -90, 90, 'Latitud');
          const lng = optCoord(body.lng, -180, 180, 'Longitud');
          const accuracy = optCoord(body.accuracy, 0, 100000, 'Precisión');
          if ((lat === null) !== (lng === null)) throw bad('Debes enviar latitud y longitud juntas.');
          updateOrder(o.id, { status: 'delivered', delivered_at: now, delivery_lat: lat, delivery_lng: lng,
            delivery_accuracy: lat === null ? null : accuracy, updated_at: now });
          logEvent(o.id, user, action, st, 'delivered', null, lat === null ? null : { lat, lng, accuracy });
          break;
        }
        case 'incident': {
          const note = reqText(body.note, 500, 'La nota');
          need(st === 'ready' || st === 'in_transit', 'Solo se registran incidencias en pedidos listos o en ruta.');
          updateOrder(o.id, { updated_at: now });
          logEvent(o.id, user, action, st, st, note);
          break;
        }
        case 'fail': {
          const note = reqText(body.note, 500, 'La nota');
          need(st === 'in_transit', 'Solo un pedido en ruta puede marcarse no entregado.');
          updateOrder(o.id, { status: 'failed', updated_at: now });
          logEvent(o.id, user, action, st, 'failed', note);
          break;
        }
        case 'cancel': {
          const note = optText(body.note, 500, 'La nota') || null;
          need(st === 'preparing' || st === 'ready', 'Solo se cancela un pedido en preparación o listo.');
          updateOrder(o.id, { status: 'canceled', updated_at: now });
          logEvent(o.id, user, action, st, 'canceled', note);
          break;
        }
      }
      return o.id;
    });
  }

  // ----- webhook Mercat -----
  const PICKUP_TYPES = ['pickup', 'takeaway', 'take_away', 'retiro'];
  function handleWebhook(body) {
    const eventId = body.event_id;
    if ((typeof eventId !== 'string' && typeof eventId !== 'number') || !String(eventId).trim() || String(eventId).length > 200) {
      throw bad('event_id es obligatorio.');
    }
    const type = body.event_type;
    const eventTs = parseExternalTime(body.event_timestamp);
    const data = body.event_data && typeof body.event_data === 'object' && !Array.isArray(body.event_data) ? body.event_data : null;
    const supported = type === 'orders.create' || type === 'orders.update';
    if (supported) {
      if (eventTs === null) throw bad('event_timestamp inválido.');
      if (!data || data.id === undefined || data.id === null || String(data.id).trim() === '') throw bad('event_data.id es obligatorio.');
    }
    return tx(db, () => {
      const now = nowIso();
      const exists = db.prepare('SELECT 1 FROM webhook_events WHERE event_id = ?').get(String(eventId));
      if (exists) return { ok: true, applied: false, duplicate: true };
      const externalId = supported ? `mercat:${trunc(data.store_id ?? 'sin-tienda', 60)}:${trunc(data.id, 80)}` : null;
      const record = (applied) => db.prepare('INSERT INTO webhook_events (event_id, received_at, event_type, event_ts, external_id, applied) VALUES (?, ?, ?, ?, ?, ?)')
        .run(String(eventId), now, trunc(type, 60), eventTs, externalId, applied ? 1 : 0);
      if (!supported) { record(false); return { ok: true, applied: false, duplicate: false, ignored: true }; }

      const existing = q.orderByExternal.get(externalId);
      if (existing && existing.external_ts !== null && eventTs <= existing.external_ts) {
        record(false);
        return { ok: true, applied: false, duplicate: false };
      }
      const remoteStatus = data.status === undefined || data.status === null ? null : trunc(data.status, 40).toLowerCase();
      const fields = { external_ts: eventTs, updated_at: now };
      const has = (k) => data[k] !== undefined && data[k] !== null;
      const pick = (...keys) => keys.find(has);
      if (remoteStatus) fields.external_status = remoteStatus;
      let k;
      if (has('store_id')) fields.branch = trunc(data.store_id, 60) || DEFAULT_BRANCH;
      if ((k = pick('user_name', 'name'))) fields.customer_name = trunc(data[k], 120);
      if ((k = pick('user_phone', 'phone'))) fields.customer_phone = trunc(data[k], 40);
      if (has('user_address')) fields.address = trunc(data.user_address, 300);
      if ((k = pick('apartment', 'department'))) fields.address_detail = trunc(data[k], 200);
      if ((k = pick('delivery_notes', 'notes'))) fields.notes = trunc(data[k], 1000);
      const coord = (v, lim) => { const n = Number(v); return v !== '' && Number.isFinite(n) && Math.abs(n) <= lim ? n : null; };
      if (has('latitude')) fields.lat = coord(data.latitude, 90);
      if (has('longitude')) fields.lng = coord(data.longitude, 180);
      const money = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1e10 ? Math.round(n) : null; };
      if (has('delivery_price')) fields.delivery_fee = money(data.delivery_price);
      if (has('total')) fields.total = money(data.total);
      if (Array.isArray(data.products)) {
        fields.items_json = JSON.stringify(data.products.slice(0, 100).filter((p) => p && typeof p === 'object').map((p) => {
          const qty = Number(p.quantity ?? p.qty ?? 1);
          return { name: trunc(p.name, 120) || 'Producto', qty: Number.isSafeInteger(qty) && qty > 0 ? Math.min(qty, 999) : 1 };
        }));
      }
      if ((k = pick('promised_at', 'delivery_time'))) {
        const ms = parseExternalTime(data[k]);
        fields.promised_at = ms === null ? null : new Date(ms).toISOString();
      }
      if ((k = pick('delivery_type', 'type'))) fields.pickup = PICKUP_TYPES.includes(trunc(data[k], 40).toLowerCase()) ? 1 : 0;

      let id;
      let status;
      if (existing) {
        id = existing.id;
        status = existing.status;
        updateOrder(id, fields);
        logEvent(id, null, 'remote_update', status, status, null, { eventId: String(eventId), remoteStatus });
      } else {
        const createdMs = parseExternalTime(data.created_at);
        status = 'preparing';
        id = insertOrder({
          source: 'mercat', external_id: externalId, channel: 'mercat', branch: DEFAULT_BRANCH,
          status, created_at: new Date(createdMs ?? eventTs).toISOString(), ...fields,
        });
        logEvent(id, null, 'remote_create', null, status, null, { eventId: String(eventId), remoteStatus });
      }
      // Efectos locales del estado remoto.
      const eventIso = new Date(eventTs).toISOString();
      if (remoteStatus === 'ready' && status === 'preparing') {
        updateOrder(id, { status: 'ready', ready_at: eventIso });
        logEvent(id, null, 'remote_ready', status, 'ready');
      } else if (['canceled', 'cancelled', 'failed'].includes(remoteStatus) && status !== 'delivered') {
        const to = remoteStatus === 'failed' ? 'failed' : 'canceled';
        if (status !== to) {
          updateOrder(id, { status: to });
          logEvent(id, null, `remote_${to}`, status, to);
        }
      }
      record(true);
      return { ok: true, applied: true, duplicate: false, orderId: id };
    });
  }

  // ----- métricas y costos -----
  function todayChile() { return chileDay(Date.now()); }

  function parseFilters(params) {
    let from = params.get('from') || '';
    let to = params.get('to') || '';
    if (from && !isValidDay(from)) throw bad('Fecha "desde" inválida (YYYY-MM-DD).');
    if (to && !isValidDay(to)) throw bad('Fecha "hasta" inválida (YYYY-MM-DD).');
    if (!to) to = from ? (addDays(from, 6) < todayChile() ? addDays(from, 6) : todayChile()) : todayChile();
    if (!from) from = addDays(to, -6);
    if (from > to) throw bad('La fecha "desde" es posterior a "hasta".');
    if (addDays(from, 400) < to) throw bad('El rango máximo es de 400 días.');
    const branch = params.get('branch') ? optText(params.get('branch'), 60, 'Sucursal') : '';
    const driverId = optId(params.get('driverId'), 'Motorista');
    return { from, to, branch, driverId };
  }

  // Pedidos (no retiro) cuyo created_at cae en [from, to] en hora Chile.
  function ordersInRange({ from, to, branch, driverId }) {
    const lo = new Date(Date.parse(`${from}T00:00:00Z`) - 86400000).toISOString();
    const hi = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * 86400000).toISOString();
    let sql = `SELECT o.*, u.name AS driver_name FROM orders o LEFT JOIN users u ON u.id = o.driver_id
      WHERE o.pickup = 0 AND o.created_at >= ? AND o.created_at < ?`;
    const args = [lo, hi];
    if (branch) { sql += ' AND o.branch = ?'; args.push(branch); }
    if (driverId) { sql += ' AND o.driver_id = ?'; args.push(driverId); }
    sql += ' ORDER BY o.seq';
    return db.prepare(sql).all(...args).filter((o) => {
      const day = chileDay(o.created_at);
      return day >= from && day <= to;
    });
  }

  function computeMetrics(filters) {
    const rows = ordersInRange(filters);
    const iv = rows.map((o) => ({ o, ...intervals(o) }));
    const byDriver = new Map();
    const byChannel = new Map();
    for (const r of iv) {
      if (!byChannel.has(r.o.channel)) byChannel.set(r.o.channel, { orders: 0, totals: [] });
      const c = byChannel.get(r.o.channel);
      c.orders++;
      c.totals.push(r.total);
      if (r.o.status === 'delivered' && r.o.driver_id) {
        if (!byDriver.has(r.o.driver_id)) byDriver.set(r.o.driver_id, { name: r.o.driver_name, deliveries: 0, routes: [] });
        const d = byDriver.get(r.o.driver_id);
        d.deliveries++;
        d.routes.push(r.route);
      }
    }
    return {
      from: filters.from, to: filters.to,
      prep: avgOf(iv.map((r) => r.prep)),
      wait: avgOf(iv.map((r) => r.wait)),
      route: avgOf(iv.map((r) => r.route)),
      total: avgOf(iv.map((r) => r.total)),
      deliveredCount: rows.filter((o) => o.status === 'delivered').length,
      failedCount: rows.filter((o) => o.status === 'failed').length,
      canceledCount: rows.filter((o) => o.status === 'canceled').length,
      byDriver: [...byDriver].map(([driverId, d]) => ({
        driverId, name: d.name, deliveries: d.deliveries, routeAvgMinutes: avgOf(d.routes).avgMinutes,
      })).sort((a, b) => b.deliveries - a.deliveries),
      byChannel: [...byChannel].map(([channel, c]) => ({
        channel, orders: c.orders, totalAvgMinutes: avgOf(c.totals).avgMinutes,
      })).sort((a, b) => b.orders - a.orders),
    };
  }

  function computeCosts(month) {
    const row = q.costsByMonth.get(month) || {};
    const c = {};
    for (const k of ['labor', 'fuel', 'maintenance', 'insurance', 'other']) c[k] = row[k] ?? 0;
    const totalCost = c.labor + c.fuel + c.maintenance + c.insurance + c.other;
    const [y, m] = month.split('-').map(Number);
    const lo = new Date(Date.UTC(y, m - 1, 1) - 86400000).toISOString();
    const hi = new Date(Date.UTC(y, m, 2)).toISOString();
    const delivered = db.prepare(`SELECT delivered_at, delivery_fee FROM orders
      WHERE status = 'delivered' AND pickup = 0 AND delivered_at >= ? AND delivered_at < ?`).all(lo, hi)
      .filter((o) => chileMonth(o.delivered_at) === month);
    const feesInMonth = delivered.reduce((s, o) => s + (o.delivery_fee || 0), 0);
    return {
      month, ...c, totalCost,
      deliveredInMonth: delivered.length,
      costPerDelivery: delivered.length ? round1(totalCost / delivered.length) : null,
      feesInMonth,
      feesMinusCost: feesInMonth - totalCost,
      updatedAt: row.updated_at ?? null,
    };
  }

  function buildState(user, params) {
    const role = user.role;
    const since = new Date(Date.now() - 86400000).toISOString();
    let sql = `SELECT o.*, u.name AS driver_name FROM orders o LEFT JOIN users u ON u.id = o.driver_id
      WHERE (o.status IN ('preparing','ready','in_transit') OR o.updated_at >= ?)`;
    const args = [since];
    if (role === 'driver') { sql += ' AND o.driver_id = ?'; args.push(user.id); }
    sql += ' ORDER BY o.seq DESC LIMIT 1000';
    const rows = db.prepare(sql).all(...args);
    const inc = incidentsFor(rows.map((r) => r.id));
    const state = {
      user: publicUser(user),
      serverTime: nowIso(),
      orders: rows.map((r) => toOrder(r, inc, role)),
      drivers: [], users: [], branches: [], metrics: null, costs: null,
    };
    if (role === 'driver') return state;
    const filters = parseFilters(params);
    state.drivers = db.prepare("SELECT id, name, active FROM users WHERE role = 'driver' ORDER BY name").all()
      .map((d) => ({ id: d.id, name: d.name, active: !!d.active }));
    const branches = new Set([DEFAULT_BRANCH]);
    for (const b of db.prepare('SELECT DISTINCT branch FROM orders').all()) if (b.branch) branches.add(b.branch);
    state.branches = [...branches].sort();
    state.metrics = computeMetrics(filters);
    if (role === 'admin') {
      state.users = db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser);
      const costMonth = params.get('costMonth') || todayChile().slice(0, 7);
      if (!isValidMonth(costMonth)) throw bad('Mes inválido (YYYY-MM).');
      state.costs = computeCosts(costMonth);
      const { enabled, lastSyncAt, lastError, pendingChanges } = sheets.status();
      state.sheets = { enabled, lastSyncAt, lastError, pendingChanges };
    }
    return state;
  }

  function sheetsSnapshot(days) {
    const to = todayChile();
    const all = { branch: '', driverId: null };
    const rows = ordersInRange({ from: addDays(to, -(days - 1)), to, ...all });
    const inc = new Map();
    for (let i = 0; i < rows.length; i += 500) {
      for (const [k, v] of incidentsFor(rows.slice(i, i + 500).map((r) => r.id))) inc.set(k, v);
    }
    const distanceColumns = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name).filter((n) => /distan/i.test(n));
    return {
      generatedAt: nowIso(),
      orders: rows.map((o) => ({ ...o, minutes: intervals(o), incidents: inc.get(o.id) || [] })),
      distanceColumns,
      metrics7: computeMetrics({ from: addDays(to, -6), to, ...all }),
      metrics30: computeMetrics({ from: addDays(to, -29), to, ...all }),
      costs: computeCosts(to.slice(0, 7)),
    };
  }

  function buildCsv(filters) {
    const header = ['id', 'fecha', 'origen', 'canal', 'sucursal', 'estado', 'estado_mercat', 'motorista', 'cliente',
      'direccion', 'tarifa_despacho', 'total', 'creado', 'listo', 'salida', 'entrega',
      'min_preparacion', 'min_espera', 'min_ruta', 'min_total'];
    const fmt = (n) => (n === null ? '' : round1(n).toFixed(1).replace('.', ','));
    const lines = [header.join(';')];
    for (const o of ordersInRange(filters)) {
      const iv = intervals(o);
      lines.push([
        o.id, chileDay(o.created_at), o.source, o.channel, o.branch, o.status, o.external_status, o.driver_name,
        o.customer_name, [o.address, o.address_detail].filter(Boolean).join(', '), o.delivery_fee, o.total,
        chileDateTime(o.created_at), chileDateTime(o.ready_at), chileDateTime(o.departed_at), chileDateTime(o.delivered_at),
        fmt(iv.prep), fmt(iv.wait), fmt(iv.route), fmt(iv.total),
      ].map(csvCell).join(';'));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  // ----- login con límite de intentos -----
  function loginKey(req, username) { return `${req.socket.remoteAddress || ''}|${username}`; }
  function checkRate(key) {
    const now = Date.now();
    if (loginAttempts.size > 5000) {
      for (const [k, v] of loginAttempts) if (now - v.start > LOGIN_WINDOW_MS) loginAttempts.delete(k);
    }
    const e = loginAttempts.get(key);
    if (e && now - e.start <= LOGIN_WINDOW_MS && e.count >= LOGIN_MAX_FAILS) {
      throw new HttpError(429, 'rate_limited', 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
    }
  }
  function registerFail(key) {
    const now = Date.now();
    const e = loginAttempts.get(key);
    if (!e || now - e.start > LOGIN_WINDOW_MS) loginAttempts.set(key, { start: now, count: 1 });
    else e.count++;
  }
  const DUMMY = { salt: crypto.randomBytes(16).toString('base64'), hash: crypto.randomBytes(64).toString('base64') };

  // ----- rutas -----
  async function handleApi(req, res, url) {
    const method = req.method;
    const route = `${method} ${url.pathname}`;

    if (route === 'POST /api/webhooks/mercat') {
      if (!config.webhookSecret) throw new HttpError(503, 'not_configured', 'Webhook de Mercat no configurado.');
      const secret = req.headers['x-webhook-secret'];
      if (typeof secret !== 'string' || !safeEqual(secret, config.webhookSecret)) {
        req.resume();
        throw new HttpError(401, 'unauthorized', 'Secreto de webhook inválido.');
      }
      return send(res, 200, handleWebhook(await readBody(req)));
    }

    if (method === 'POST') checkOrigin(req);

    switch (route) {
      case 'GET /api/status':
        return send(res, 200, { needsSetup: q.userCount.get().n === 0, setupTokenRequired: !!config.setupToken });

      case 'POST /api/setup': {
        const body = await readBody(req);
        if (q.userCount.get().n > 0) throw forbidden('El sistema ya fue configurado.');
        if (config.setupToken) {
          // Sin límite, el código de alta podría probarse por fuerza bruta (no hay scrypt antes de compararlo).
          const key = `${req.socket.remoteAddress || ''}|\u0000setup`;
          checkRate(key);
          if (typeof body.setupToken !== 'string' || !safeEqual(body.setupToken, config.setupToken)) {
            registerFail(key);
            throw forbidden('Código de instalación inválido.');
          }
        }
        const name = reqText(body.name, 80, 'Nombre');
        const username = validateUsername(body.username);
        const { salt, hash } = await hashPassword(validatePassword(body.password));
        const id = tx(db, () => {
          if (q.userCount.get().n > 0) throw forbidden('El sistema ya fue configurado.');
          return q.insertUser.get(name, username, 'admin', salt, hash, nowIso()).id;
        });
        return send(res, 200, { user: publicUser(q.userById.get(id)) }, { 'Set-Cookie': createSession(id, req) });
      }

      case 'POST /api/login': {
        const body = await readBody(req);
        const username = typeof body.username === 'string' ? body.username.trim().toLowerCase().slice(0, 60) : '';
        const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
        const key = loginKey(req, username);
        checkRate(key);
        const user = username ? q.userByName.get(username) : null;
        const ok = await verifyPassword(password, user?.pass_salt ?? DUMMY.salt, user?.pass_hash ?? DUMMY.hash);
        if (!user || !ok || !user.active) {
          registerFail(key);
          throw new HttpError(401, 'unauthorized', 'Usuario o contraseña incorrectos.');
        }
        loginAttempts.delete(key);
        return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': createSession(user.id, req) });
      }

      case 'POST /api/logout': {
        const token = parseCookies(req.headers.cookie).sid;
        if (token) q.deleteSession.run(tokenHash(token));
        return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0, req) });
      }

      case 'GET /api/state': {
        const { user } = requireUser(req);
        return send(res, 200, buildState(user, url.searchParams));
      }

      case 'POST /api/users': {
        requireUser(req, ['admin']);
        const body = await readBody(req);
        const name = reqText(body.name, 80, 'Nombre');
        const username = validateUsername(body.username);
        if (!ROLES.includes(body.role)) throw bad('Rol inválido.');
        const { salt, hash } = await hashPassword(validatePassword(body.password));
        if (q.userByName.get(username)) throw bad('Ese nombre de usuario ya existe.');
        let id;
        try {
          id = q.insertUser.get(name, username, body.role, salt, hash, nowIso()).id;
        } catch (err) {
          if (/UNIQUE/.test(err.message)) throw bad('Ese nombre de usuario ya existe.');
          throw err;
        }
        return send(res, 200, { user: publicUser(q.userById.get(id)) });
      }

      case 'POST /api/users/update': {
        const session = requireUser(req, ['admin']);
        const body = await readBody(req);
        const id = optId(body.id, 'Usuario');
        if (!id) throw bad('Debes indicar el usuario.');
        const target = q.userById.get(id);
        if (!target) throw notFound('Usuario no encontrado.');
        let hashed = null;
        if (body.password !== undefined && body.password !== null && body.password !== '') {
          hashed = await hashPassword(validatePassword(body.password));
        }
        if (body.active !== undefined && typeof body.active !== 'boolean') throw bad('active debe ser verdadero o falso.');
        if (body.active === false && id === session.user.id) throw bad('No puedes desactivar tu propia cuenta.');
        tx(db, () => {
          if (hashed) db.prepare('UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?').run(hashed.salt, hashed.hash, id);
          if (body.active !== undefined) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(body.active ? 1 : 0, id);
          // Desactivar o cambiar contraseña cierra las sesiones del usuario (salvo la del propio admin que la cambia).
          if (hashed || body.active === false) q.deleteUserSessions.run(id, session.tokenHash);
        });
        return send(res, 200, { user: publicUser(q.userById.get(id)) });
      }

      case 'POST /api/orders': {
        const { user } = requireUser(req, ['admin', 'local']);
        const id = createManualOrder(await readBody(req), user);
        return send(res, 200, { order: loadOrder(id, user.role) });
      }

      case 'POST /api/action': {
        const { user } = requireUser(req);
        const id = applyAction(await readBody(req), user);
        return send(res, 200, { order: loadOrder(id, user.role) });
      }

      case 'POST /api/settings': {
        const { user } = requireUser(req, ['admin']);
        const body = await readBody(req);
        if (!isValidMonth(body.month)) throw bad('Mes inválido (YYYY-MM).');
        const labels = { labor: 'Mano de obra', fuel: 'Combustible', maintenance: 'Mantención', insurance: 'Seguros', other: 'Otros' };
        const v = {};
        for (const [k, label] of Object.entries(labels)) v[k] = optMoney(body[k], label) ?? 0;
        db.prepare(`INSERT INTO monthly_costs (month, labor, fuel, maintenance, insurance, other, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(month) DO UPDATE SET labor = excluded.labor, fuel = excluded.fuel, maintenance = excluded.maintenance,
            insurance = excluded.insurance, other = excluded.other, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
          .run(body.month, v.labor, v.fuel, v.maintenance, v.insurance, v.other, nowIso(), user.id);
        sheets.markDirty();
        return send(res, 200, { costs: computeCosts(body.month) });
      }

      case 'POST /api/sheets/sync': {
        requireUser(req, ['admin']);
        if (!sheets.enabled) throw new HttpError(503, 'not_configured', 'La copia a Google Sheets no está configurada.');
        // Espera la copia hasta 20 s; si tarda más, responde el estado actual y la copia sigue en segundo plano.
        const pending = sheets.syncNow();
        const st = await Promise.race([pending, new Promise((r) => setTimeout(r, 20000).unref())]);
        const { enabled, lastSyncAt, lastError, pendingChanges } = st || sheets.status();
        return send(res, 200, { sheets: { enabled, lastSyncAt, lastError, pendingChanges } });
      }

      case 'GET /api/qr': {
        const { user } = requireUser(req);
        if (!url.searchParams.get('id')) throw bad('Falta el id del pedido.');
        const row = findAccessibleOrder(url.searchParams.get('id'), user);
        const order = toOrder(row, new Map(), user.role);
        return send(res, 200, buildLabelSvg(order), {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Content-Disposition': `inline; filename="${row.id}.svg"`,
        });
      }

      case 'GET /api/export.csv': {
        requireUser(req, ['admin']);
        const filters = parseFilters(url.searchParams);
        return send(res, 200, buildCsv(filters), {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="despachos_${filters.from}_${filters.to}.csv"`,
        });
      }
    }
    const known = ['/api/status', '/api/setup', '/api/login', '/api/logout', '/api/state', '/api/users', '/api/users/update',
      '/api/orders', '/api/action', '/api/settings', '/api/qr', '/api/export.csv', '/api/webhooks/mercat', '/api/sheets/sync'];
    if (known.includes(url.pathname)) throw new HttpError(405, 'method_not_allowed', 'Método no permitido.');
    throw notFound('Ruta no encontrada.');
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Método no permitido', { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { rel = null; }
    const notFoundText = () => send(res, 404, 'No encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (rel === null || rel.includes('\0') || rel.includes('\\')) return notFoundText();
    if (rel.endsWith('/')) rel += 'index.html';
    const root = path.resolve(publicDir);
    const file = path.resolve(root, '.' + path.posix.normalize(rel));
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).some((p) => p.startsWith('.'))) {
      return notFoundText();
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFoundText();
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': type,
        'Content-Length': st.size,
        'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, { error: 'bad_request', message: 'URL inválida.' });
    }
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) send(res, err.status, { error: err.code, message: err.message }, err.status === 413 ? { Connection: 'close' } : {});
      } else {
        console.error('[error]', err);
        if (!res.headersSent) send(res, 500, { error: 'server_error', message: 'Error interno del servidor.' });
      }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await sheets.stop();
    await new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    db.close();
  }

  sheets.start();

  return { server, db, config, sheets, close };
}

// Arranque directo: node server.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  loadDotEnv();
  const app = createApp();
  const { host, port, origins } = app.config;
  app.server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `El puerto ${port} ya está en uso. Cambia PORT en .env.` : err);
    process.exit(1);
  });
  app.server.listen(port, host, () => {
    console.log(`Despachos Osake escuchando en http://${host}:${port}`);
    console.log(`Orígenes permitidos: ${origins.join(', ')}`);
    if (!app.config.webhookSecret) console.log('Aviso: MERCAT_WEBHOOK_SECRET no definido; el webhook responderá 503.');
    console.log(app.sheets.enabled ? 'Copia a Google Sheets activada.' : 'Copia a Google Sheets desactivada (sin GOOGLE_SHEETS_ID o GOOGLE_SERVICE_ACCOUNT_FILE).');
  });
  const stop = () => { app.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
