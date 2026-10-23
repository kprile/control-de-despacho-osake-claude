// Copia automática de solo lectura a Google Sheets (ver docs/CONTRATO.md, "Copia a Google Sheets").
// SQLite es la fuente de verdad; la hoja se reescribe completa desde el servidor y la app nunca la lee.
// Sin dependencias: JWT RS256 de cuenta de servicio firmado con node:crypto y fetch nativo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const NET_TIMEOUT_MS = 15000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
export const SHEET_ORDERS = 'Pedidos';
export const SHEET_SUMMARY = 'Resumen';

const TZ = 'America/Santiago';
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
export function chileDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const p = {};
  for (const { type, value: v } of fmt.formatToParts(d)) p[type] = v;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// Evita que un texto se interprete como fórmula (RAW ya lo mitiga; esto es defensa adicional).
export function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (typeof value === 'boolean') return value ? 'sí' : 'no';
  const s = String(value);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

const STATUS_LABEL = {
  preparing: 'En preparación', ready: 'Listo', in_transit: 'En ruta',
  delivered: 'Entregado', canceled: 'Cancelado', failed: 'No entregado',
};
const round1 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
const distanceLabel = (col) => {
  const base = col.replace(/^delivery_/, '').replace(/_/g, ' ');
  return /_m$/.test(col) ? `${base.replace(/ m$/, '')} (m)` : base;
};

// snapshot: { generatedAt, orders: [fila de orders + driver_name + minutes{prep,wait,route,total} + incidents[]],
//   distanceColumns: [nombres de columna], metrics7, metrics30, costs }
export function buildOrdersTable(snapshot) {
  const dist = snapshot.distanceColumns || [];
  const header = ['id', 'origen', 'canal', 'sucursal', 'cliente', 'dirección', 'motorista', 'estado', 'estado externo',
    'tarifa (CLP)', 'monto pedido (CLP)', 'creado', 'listo', 'salida', 'entregado',
    'min hasta listo', 'min espera retiro', 'min reparto', 'min total', 'incidencias', ...dist.map(distanceLabel)];
  const rows = [header];
  for (const o of snapshot.orders) {
    const m = o.minutes || {};
    rows.push([
      o.id, o.source, o.channel, o.branch, o.customer_name,
      [o.address, o.address_detail].filter(Boolean).join(', '),
      o.driver_name ?? '', STATUS_LABEL[o.status] || o.status, o.external_status ?? '',
      o.delivery_fee, o.total,
      chileDateTime(o.created_at), chileDateTime(o.ready_at), chileDateTime(o.departed_at), chileDateTime(o.delivered_at),
      round1(m.prep), round1(m.wait), round1(m.route), round1(m.total),
      (o.incidents || []).map((i) => `${chileDateTime(i.at)} ${i.by}: ${i.note}`).join(' | '),
      ...dist.map((c) => o[c]),
    ].map(cell));
  }
  return rows;
}

export function buildSummaryTable(snapshot) {
  const a = snapshot.metrics7 || {};
  const b = snapshot.metrics30 || {};
  const c = snapshot.costs || {};
  const avg = (m) => round1(m?.avgMinutes ?? null);
  const rows = [
    ['Resumen de despachos Osake', ''],
    ['Actualizado (hora Chile)', chileDateTime(snapshot.generatedAt)],
    ['Copia automática de solo lectura. Los cambios hechos aquí se pierden en la siguiente copia.', ''],
    [],
    ['Indicador', 'Últimos 7 días', 'Últimos 30 días'],
    ['Desde', a.from, b.from],
    ['Hasta', a.to, b.to],
    ['Promedio min hasta listo', avg(a.prep), avg(b.prep)],
    ['Pedidos con dato (hasta listo)', a.prep?.count, b.prep?.count],
    ['Promedio min espera retiro', avg(a.wait), avg(b.wait)],
    ['Pedidos con dato (espera)', a.wait?.count, b.wait?.count],
    ['Promedio min reparto', avg(a.route), avg(b.route)],
    ['Pedidos con dato (reparto)', a.route?.count, b.route?.count],
    ['Promedio min total', avg(a.total), avg(b.total)],
    ['Pedidos con dato (total)', a.total?.count, b.total?.count],
    ['Entregados', a.deliveredCount, b.deliveredCount],
    ['No entregados', a.failedCount, b.failedCount],
    ['Cancelados', a.canceledCount, b.canceledCount],
    [],
    ['Costos del mes', c.month],
    ['Personal', c.labor],
    ['Combustible', c.fuel],
    ['Mantención', c.maintenance],
    ['Seguros', c.insurance],
    ['Otros', c.other],
    ['Costo total', c.totalCost],
    ['Entregas del mes', c.deliveredInMonth],
    ['Costo promedio por entrega (asignado)', c.costPerDelivery],
    ['Tarifas cobradas', c.feesInMonth],
    ['Tarifas menos costos', c.feesMinusCost],
  ];
  return rows.map((r) => r.map(cell));
}

// ---------- Autenticación ----------

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signJwt(clientEmail, privateKey, tokenUrl, nowSec = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: clientEmail, scope: SCOPE, aud: tokenUrl, iat: nowSec, exp: nowSec + 3600 }));
  const input = `${header}.${claims}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey);
  return `${input}.${b64url(sig)}`;
}

class SyncError extends Error {}

function readConfig(env) {
  const id = String(env.GOOGLE_SHEETS_ID || '').trim();
  const file = String(env.GOOGLE_SERVICE_ACCOUNT_FILE || '').trim();
  const interval = Number(env.GOOGLE_SHEETS_INTERVAL_SECONDS);
  const days = Number(env.GOOGLE_SHEETS_DAYS);
  return {
    enabled: !!(id && file),
    spreadsheetId: id,
    keyFile: file ? path.resolve(file) : '',
    intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 60) * 1000,
    days: Number.isInteger(days) && days > 0 && days <= 400 ? days : 90,
    apiBase: String(env.GOOGLE_API_BASE || 'https://sheets.googleapis.com').replace(/\/+$/, ''),
    tokenUrl: String(env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token'),
  };
}

// getSnapshot(days) => snapshot (ver buildOrdersTable). Se llama solo dentro de la sincronización.
export function createSheetsSync({ env = process.env, getSnapshot, log = console } = {}) {
  const cfg = readConfig(env);
  const status = { enabled: cfg.enabled, lastSyncAt: null, lastError: null, pendingChanges: cfg.enabled };
  let generation = 0;     // sube con cada cambio
  let failures = 0;
  let nextAttemptAt = 0;
  let lastAttemptAt = 0;
  let running = null;
  let timer = null;
  let stopped = false;
  let token = null;       // { value, expiresAt }
  let credentials = null; // { clientEmail, privateKey }

  function loadCredentials() {
    if (credentials) return credentials;
    let json;
    try { json = JSON.parse(fs.readFileSync(cfg.keyFile, 'utf8')); } catch {
      throw new SyncError('No se pudo leer el archivo de la cuenta de servicio (GOOGLE_SERVICE_ACCOUNT_FILE).');
    }
    if (!json || typeof json.client_email !== 'string' || typeof json.private_key !== 'string') {
      throw new SyncError('El archivo de la cuenta de servicio no tiene client_email y private_key.');
    }
    let privateKey;
    try { privateKey = crypto.createPrivateKey(json.private_key); } catch {
      throw new SyncError('La clave privada de la cuenta de servicio no es válida.');
    }
    credentials = { clientEmail: json.client_email, privateKey };
    return credentials;
  }

  async function request(url, { method = 'GET', headers = {}, body, what }) {
    let res;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(NET_TIMEOUT_MS) });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'tiempo de espera agotado' : 'sin conexión';
      throw new SyncError(`Google no respondió (${what}: ${reason}).`);
    }
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      if (res.status === 401) token = null;
      // Solo el mensaje público de Google, recortado; nunca encabezados ni el token.
      const gmsg = typeof data?.error?.message === 'string' ? data.error.message
        : typeof data?.error_description === 'string' ? data.error_description
          : typeof data?.error === 'string' ? data.error : '';
      throw new SyncError(`Google respondió ${res.status} en ${what}${gmsg ? `: ${gmsg.slice(0, 160)}` : ''}.`);
    }
    return data;
  }

  async function accessToken() {
    if (token && Date.now() < token.expiresAt - 60000) return token.value;
    const { clientEmail, privateKey } = loadCredentials();
    const assertion = signJwt(clientEmail, privateKey, cfg.tokenUrl);
    const data = await request(cfg.tokenUrl, {
      method: 'POST', what: 'token',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (!data || typeof data.access_token !== 'string') throw new SyncError('Google no entregó un token de acceso.');
    const ttl = Number(data.expires_in);
    token = { value: data.access_token, expiresAt: Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 3600) * 1000 };
    return token.value;
  }

  async function sheetsCall(suffix, method, body, what) {
    const auth = await accessToken();
    return request(`${cfg.apiBase}/v4/spreadsheets/${encodeURIComponent(cfg.spreadsheetId)}${suffix}`, {
      method, what,
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function doSync() {
    const gen = generation;
    lastAttemptAt = Date.now();
    try {
      const snapshot = getSnapshot(cfg.days);
      const orders = buildOrdersTable(snapshot);
      const summary = buildSummaryTable(snapshot);
      const meta = await sheetsCall('?fields=sheets.properties.title', 'GET', undefined, 'spreadsheets.get');
      const titles = new Set((meta?.sheets || []).map((s) => s?.properties?.title));
      const missing = [SHEET_ORDERS, SHEET_SUMMARY].filter((t) => !titles.has(t));
      if (missing.length) {
        await sheetsCall(':batchUpdate', 'POST', { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
          'addSheet');
      }
      await sheetsCall('/values:batchClear', 'POST', { ranges: [`'${SHEET_ORDERS}'`, `'${SHEET_SUMMARY}'`] }, 'values:batchClear');
      await sheetsCall('/values:batchUpdate', 'POST', {
        valueInputOption: 'RAW',
        data: [
          { range: `'${SHEET_ORDERS}'!A1`, majorDimension: 'ROWS', values: orders },
          { range: `'${SHEET_SUMMARY}'!A1`, majorDimension: 'ROWS', values: summary },
        ],
      }, 'values:batchUpdate');
      status.lastSyncAt = new Date().toISOString();
      status.lastError = null;
      failures = 0;
      nextAttemptAt = 0;
      if (gen === generation) status.pendingChanges = false;
    } catch (err) {
      failures++;
      // La hoja puede haber quedado a medio escribir (p. ej. borrada y no reescrita): se reintenta.
      status.pendingChanges = true;
      nextAttemptAt = Date.now() + Math.min(cfg.intervalMs * 2 ** failures, MAX_BACKOFF_MS);
      status.lastError = err instanceof SyncError ? err.message : 'Error interno al preparar la copia.';
      if (!(err instanceof SyncError)) log.error?.('[sheets] error interno:', err?.message || err);
      else log.warn?.(`[sheets] ${status.lastError}`);
    }
  }

  function run() {
    if (!running) running = doSync().finally(() => { running = null; });
    return running;
  }

  function tick() {
    if (stopped || running || !status.pendingChanges) return;
    const now = Date.now();
    if (now < nextAttemptAt || now - lastAttemptAt < cfg.intervalMs) return;
    run();
  }

  return {
    get enabled() { return cfg.enabled; },
    markDirty() {
      if (!cfg.enabled) return;
      generation++;
      status.pendingChanges = true;
    },
    start() {
      if (!cfg.enabled || timer || stopped) return;
      lastAttemptAt = Date.now() - cfg.intervalMs; // primera copia en el siguiente tick
      timer = setInterval(tick, Math.min(5000, cfg.intervalMs));
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (running) await running.catch(() => {});
    },
    // Fuerza una copia (ignora intervalo y espera de reintento). Si ya hay una en curso, espera esa.
    async syncNow() {
      if (!cfg.enabled || stopped) return this.status();
      if (running) await running;
      await run();
      return this.status();
    },
    status() { return { ...status }; },
  };
}
