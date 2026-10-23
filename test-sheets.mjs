// Pruebas de la copia a Google Sheets con un servidor HTTP falso (token + API de Sheets). No usa Google real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from './server.mjs';
import { cell } from './sheets.mjs';

const ORIGIN = 'http://despachos.test';
const SECRET = 'secreto-mercat-123';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'despachos-sheets-'));
const apps = [];

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const CLIENT_EMAIL = 'copia@proyecto-prueba.iam.gserviceaccount.com';
const keyFile = path.join(tmp, 'service-account.json');
fs.writeFileSync(keyFile, JSON.stringify({
  type: 'service_account', client_email: CLIENT_EMAIL,
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
}));

// ----- Google falso -----
const fake = {
  calls: [], tokenRequests: 0, sheets: new Set(['Hoja 1']), values: {}, failUpdate: false, jwtErrors: [],
};
const TOKEN = 'token-falso-abc';
let fakeBase;
const fakeServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const url = new URL(req.url, 'http://x');
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  fake.calls.push(`${req.method} ${url.pathname}`);
  if (url.pathname === '/token') {
    fake.tokenRequests++;
    const form = new URLSearchParams(raw);
    const [h, p, s] = String(form.get('assertion')).split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url'));
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'));
    if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') fake.jwtErrors.push('grant_type');
    if (!ok) fake.jwtErrors.push('firma');
    if (header.alg !== 'RS256') fake.jwtErrors.push('alg');
    if (claims.iss !== CLIENT_EMAIL) fake.jwtErrors.push('iss');
    if (claims.scope !== 'https://www.googleapis.com/auth/spreadsheets') fake.jwtErrors.push('scope');
    if (claims.aud !== `${fakeBase}/token`) fake.jwtErrors.push('aud');
    if (!(claims.exp > claims.iat)) fake.jwtErrors.push('exp');
    if (!ok) return json(400, { error: 'invalid_grant' });
    return json(200, { access_token: TOKEN, expires_in: 3600, token_type: 'Bearer' });
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: { message: 'sin token' } });
  const m = url.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)(.*)$/);
  if (!m || m[1] !== 'hoja-prueba') return json(404, { error: { message: 'Requested entity was not found.' } });
  const rest = m[2];
  const body = raw ? JSON.parse(raw) : {};
  if (req.method === 'GET' && rest === '') {
    return json(200, { sheets: [...fake.sheets].map((title) => ({ properties: { title } })) });
  }
  if (rest === ':batchUpdate') {
    for (const r of body.requests) fake.sheets.add(r.addSheet.properties.title);
    return json(200, {});
  }
  if (rest === '/values:batchClear') {
    for (const r of body.ranges) delete fake.values[r.replace(/'/g, '')];
    return json(200, {});
  }
  if (rest === '/values:batchUpdate') {
    if (fake.failUpdate) return json(403, { error: { message: 'The caller does not have permission' } });
    assert.equal(body.valueInputOption, 'RAW');
    for (const d of body.data) {
      const title = d.range.split('!')[0].replace(/'/g, '');
      assert.ok(fake.sheets.has(title), `pestaña ${title} debe existir`);
      fake.values[title] = d.values;
    }
    return json(200, {});
  }
  return json(404, { error: { message: 'ruta desconocida' } });
});

async function start(env = {}) {
  const app = createApp({
    dbPath: path.join(tmp, `db-${apps.length}.sqlite`),
    env: { PUBLIC_ORIGIN: ORIGIN, MERCAT_WEBHOOK_SECRET: SECRET, ...env },
  });
  apps.push(app);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}
const sheetsEnv = () => ({
  GOOGLE_SHEETS_ID: 'hoja-prueba', GOOGLE_SERVICE_ACCOUNT_FILE: keyFile,
  GOOGLE_SHEETS_INTERVAL_SECONDS: '3600', GOOGLE_API_BASE: fakeBase, GOOGLE_TOKEN_URL: `${fakeBase}/token`,
});

function client(base) {
  let cookie = '';
  async function req(method, url, body) {
    const h = {};
    if (cookie) h.cookie = cookie;
    if (method === 'POST') { h.origin = ORIGIN; h['content-type'] = 'application/json'; }
    const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  }
  return { get: (u) => req('GET', u), post: (u, b) => req('POST', u, b ?? {}) };
}
function webhook(base, body) {
  return fetch(`${base}/api/webhooks/mercat`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET }, body: JSON.stringify(body),
  }).then((r) => r.json());
}

// Servidor con copia activada y datos de prueba.
let base, app, admin, local, moto, driverId;
before(async () => {
  await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
  fakeBase = `http://127.0.0.1:${fakeServer.address().port}`;
  ({ base, app } = await start(sheetsEnv()));
  admin = client(base);
  assert.equal((await admin.post('/api/setup', { name: 'Admin', username: 'admin', password: '123456' })).status, 200);
  for (const [username, role, name] of [['local1', 'local', 'Caja'], ['moto1', 'driver', 'Jorge']]) {
    const r = await admin.post('/api/users', { name, username, password: 'abcdef', role });
    if (role === 'driver') driverId = r.data.user.id;
  }
  local = client(base); moto = client(base);
  await local.post('/api/login', { username: 'local1', password: 'abcdef' });
  await moto.post('/api/login', { username: 'moto1', password: 'abcdef' });

  const o = await local.post('/api/orders', { address: 'Ortúzar 123', customerName: '=HYPERLINK("http://x")', deliveryFee: 2500, total: 15900 });
  const id = o.data.order.id;
  await local.post('/api/action', { orderId: id, action: 'ready' });
  await local.post('/api/action', { orderId: id, action: 'assign', driverId });
  await moto.post('/api/action', { orderId: id, action: 'depart' });
  await moto.post('/api/action', { orderId: id, action: 'incident', note: '-sin timbre' });
  await moto.post('/api/action', { orderId: id, action: 'deliver' });
  await local.post('/api/orders', { address: 'Serrano 45', channel: 'telefono' });
  const ts = new Date().toISOString();
  await webhook(base, { event_id: 'e1', event_type: 'orders.create', event_timestamp: ts,
    event_data: { id: 'R1', store_id: 'S', status: 'preparing', user_address: 'Retiro 1', delivery_type: 'pickup' } });
  await webhook(base, { event_id: 'e2', event_type: 'orders.create', event_timestamp: ts,
    event_data: { id: 'D1', store_id: 'S', status: 'preparing', user_address: 'Delivery Mercat 9', delivery_type: 'delivery' } });
});

after(async () => {
  for (const a of apps) await a.close();
  await new Promise((r) => fakeServer.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('sin configuración queda deshabilitado y no falla', async () => {
  const { base: b } = await start();
  const c = client(b);
  await c.post('/api/setup', { name: 'A', username: 'admin', password: '123456' });
  const st = await c.get('/api/state');
  assert.equal(st.status, 200);
  assert.deepEqual(st.data.sheets, { enabled: false, lastSyncAt: null, lastError: null, pendingChanges: false });
  const r = await c.post('/api/sheets/sync');
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'not_configured');
  // Solo ID sin archivo: también deshabilitado.
  const { app: a2 } = await start({ GOOGLE_SHEETS_ID: 'x' });
  assert.equal(a2.sheets.status().enabled, false);
});

test('motorista y local no pueden forzar la copia; sin Origin se rechaza', async () => {
  assert.equal((await moto.post('/api/sheets/sync')).status, 403);
  assert.equal((await local.post('/api/sheets/sync')).status, 403);
  const noOrigin = await fetch(`${base}/api/sheets/sync`, { method: 'POST' });
  assert.equal(noOrigin.status, 403);
  assert.equal((await noOrigin.json()).error, 'bad_origin');
  assert.equal((await local.get('/api/state')).data.sheets, undefined);
  assert.equal((await moto.get('/api/state')).data.sheets, undefined);
});

test('copia completa: JWT firmado, pestañas creadas, encabezado y filas, pickup excluido', async () => {
  const before = (await admin.get('/api/state')).data.sheets;
  assert.equal(before.enabled, true);
  assert.equal(before.pendingChanges, true);

  const r = await admin.post('/api/sheets/sync');
  assert.equal(r.status, 200);
  assert.equal(r.data.sheets.lastError, null);
  assert.ok(r.data.sheets.lastSyncAt);
  assert.equal(r.data.sheets.pendingChanges, false);
  assert.deepEqual(fake.jwtErrors, []);
  assert.equal(fake.tokenRequests, 1);
  assert.ok(fake.sheets.has('Pedidos') && fake.sheets.has('Resumen'));
  assert.ok(fake.calls.includes('POST /v4/spreadsheets/hoja-prueba/values:batchClear'));

  const rows = fake.values.Pedidos;
  const header = rows[0];
  assert.deepEqual(header.slice(0, 20), ['id', 'origen', 'canal', 'sucursal', 'cliente', 'dirección', 'motorista', 'estado',
    'estado externo', 'tarifa (CLP)', 'monto pedido (CLP)', 'creado', 'listo', 'salida', 'entregado',
    'min hasta listo', 'min espera retiro', 'min reparto', 'min total', 'incidencias']);
  assert.equal(rows.length, 4, 'tres pedidos de delivery (el de retiro se excluye)');
  const col = (name) => header.indexOf(name);
  const byAddr = (a) => rows.find((x) => String(x[col('dirección')]).startsWith(a));
  assert.equal(byAddr('Retiro 1'), undefined);
  assert.ok(byAddr('Delivery Mercat 9'));
  const delivered = byAddr('Ortúzar 123');
  assert.equal(delivered[col('cliente')], `'=HYPERLINK("http://x")`, 'fórmula neutralizada');
  assert.equal(delivered[col('motorista')], 'Jorge');
  assert.equal(delivered[col('estado')], 'Entregado');
  assert.equal(delivered[col('tarifa (CLP)')], 2500);
  assert.match(delivered[col('entregado')], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(typeof delivered[col('min total')], 'number');
  assert.match(delivered[col('incidencias')], /Jorge: -sin timbre/);
  assert.equal(byAddr('Serrano 45')[col('entregado')], '');
  // Sin teléfono del cliente en la copia.
  assert.ok(!header.some((h) => /tel/i.test(h)));

  const summary = fake.values.Resumen;
  assert.deepEqual(summary[4], ['Indicador', 'Últimos 7 días', 'Últimos 30 días']);
  const find = (label) => summary.find((x) => x[0] === label);
  assert.deepEqual(find('Entregados').slice(1), [1, 1]);
  assert.equal(find('Tarifas cobradas')[1], 2500);

  // Reescritura idempotente: otra copia deja la misma cantidad de filas y reutiliza el token.
  await admin.post('/api/sheets/sync');
  assert.equal(fake.values.Pedidos.length, 4);
  assert.equal(fake.tokenRequests, 1);

  // Un cambio marca pendiente.
  await admin.post('/api/settings', { month: new Date().toISOString().slice(0, 7), labor: 1000 });
  assert.equal((await admin.get('/api/state')).data.sheets.pendingChanges, true);
});

test('columnas de distancia se agregan si existen en la base', async () => {
  const cols = app.db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!cols.includes('delivery_distance_m')) app.db.exec('ALTER TABLE orders ADD COLUMN delivery_distance_m REAL');
  app.db.exec("UPDATE orders SET delivery_distance_m = 42 WHERE address = 'Ortúzar 123'");
  await admin.post('/api/sheets/sync');
  const [header, ...rows] = fake.values.Pedidos;
  const i = header.findIndex((h) => /distance/.test(h));
  assert.ok(i > 0, 'hay columna de distancia');
  assert.ok(rows.some((r) => r[i] === 42));
});

test('error de la API queda en lastError sin romper el servidor', async () => {
  fake.failUpdate = true;
  try {
    const r = await admin.post('/api/sheets/sync');
    assert.equal(r.status, 200);
    assert.match(r.data.sheets.lastError, /403/);
    assert.match(r.data.sheets.lastError, /permission/);
    assert.ok(!r.data.sheets.lastError.includes(TOKEN));
    assert.equal(r.data.sheets.pendingChanges, true);
    // El servidor sigue atendiendo, incluidos webhook y pedidos.
    assert.equal((await local.post('/api/orders', { address: 'Otra 1' })).status, 200);
    const w = await webhook(base, { event_id: 'e3', event_type: 'orders.create', event_timestamp: new Date().toISOString(),
      event_data: { id: 'D2', store_id: 'S', user_address: 'X' } });
    assert.equal(w.applied, true);
    assert.equal((await admin.get('/api/state')).data.sheets.lastError, r.data.sheets.lastError);
  } finally {
    fake.failUpdate = false;
  }
  const ok = await admin.post('/api/sheets/sync');
  assert.equal(ok.data.sheets.lastError, null);
});

test('Google inalcanzable o archivo de clave ausente: error controlado', async () => {
  const { app: a } = await start({ ...sheetsEnv(), GOOGLE_TOKEN_URL: 'http://127.0.0.1:1/token' });
  const st = await a.sheets.syncNow();
  assert.match(st.lastError, /token/);
  const { app: b } = await start({ ...sheetsEnv(), GOOGLE_SERVICE_ACCOUNT_FILE: path.join(tmp, 'no-existe.json') });
  const st2 = await b.sheets.syncNow();
  assert.match(st2.lastError, /archivo de la cuenta de servicio/);
  assert.ok(!st2.lastError.includes(tmp), 'no expone rutas');
});

test('la copia corre sola en segundo plano cuando hay cambios', async () => {
  const { app: a } = await start({ ...sheetsEnv(), GOOGLE_SHEETS_INTERVAL_SECONDS: '1' });
  const t0 = Date.now();
  while (!a.sheets.status().lastSyncAt && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
  const st = a.sheets.status();
  assert.ok(st.lastSyncAt, 'hizo la copia automática');
  assert.equal(st.pendingChanges, false);
  assert.equal(st.lastError, null);
});

test('cell neutraliza fórmulas y conserva números', () => {
  assert.equal(cell('=1+1'), "'=1+1");
  assert.equal(cell('+56 9'), "'+56 9");
  assert.equal(cell('-x'), "'-x");
  assert.equal(cell('@a'), "'@a");
  assert.equal(cell('Hola'), 'Hola');
  assert.equal(cell(-5), -5);
  assert.equal(cell(null), '');
});
