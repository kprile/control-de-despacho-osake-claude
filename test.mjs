import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './server.mjs';

const ORIGIN = 'http://despachos.test';
const SECRET = 'secreto-mercat-123';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'despachos-test-'));
const apps = [];

async function start(env = {}) {
  const app = createApp({
    dbPath: path.join(tmp, `db-${apps.length}.sqlite`),
    env: { PUBLIC_ORIGIN: ORIGIN, MERCAT_WEBHOOK_SECRET: SECRET, ...env },
  });
  apps.push(app);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base };
}

// Cliente con su propia cookie.
function client(base) {
  let cookie = '';
  async function req(method, url, body, headers = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (method === 'POST' && !('origin' in h) && !('noOrigin' in h)) h.origin = ORIGIN;
    delete h.noOrigin;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const sc = res.headers.get('set-cookie');
    if (sc) {
      const v = sc.split(';')[0];
      cookie = v === 'sid=' ? '' : v;
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (url, headers) => req('GET', url, undefined, headers),
    post: (url, body, headers) => req('POST', url, body ?? {}, headers),
    get cookie() { return cookie; },
  };
}

function webhook(base, body, secret = SECRET) {
  const headers = { 'content-type': 'application/json' };
  if (secret !== null) headers['x-webhook-secret'] = secret;
  return fetch(`${base}/api/webhooks/mercat`, { method: 'POST', headers, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, data: await r.json() }));
}

const chileDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// Servidor principal compartido.
let base;
let admin, local, d1, d2;
let driver1Id, driver2Id;

before(async () => {
  ({ base } = await start());
  admin = client(base);
  const st = await admin.get('/api/status');
  assert.deepEqual(st.data, { needsSetup: true, setupTokenRequired: false });
  const bad = await admin.post('/api/setup', { name: 'Admin', username: 'admin', password: '12345' });
  assert.equal(bad.status, 400);
  const ok = await admin.post('/api/setup', { name: 'Admin', username: 'admin', password: '123456' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, 'admin');
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  assert.match(ok.headers.get('set-cookie'), /SameSite=Lax/);

  for (const [username, role] of [['local1', 'local'], ['moto1', 'driver'], ['moto2', 'driver']]) {
    const r = await admin.post('/api/users', { name: username === 'moto1' ? 'Jorge' : username === 'moto2' ? 'Pedro' : 'Caja', username, password: 'abcdef', role });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (username === 'moto1') driver1Id = r.data.user.id;
    if (username === 'moto2') driver2Id = r.data.user.id;
  }
  local = client(base); d1 = client(base); d2 = client(base);
  assert.equal((await local.post('/api/login', { username: 'local1', password: 'abcdef' })).status, 200);
  assert.equal((await d1.post('/api/login', { username: 'moto1', password: 'abcdef' })).status, 200);
  assert.equal((await d2.post('/api/login', { username: 'moto2', password: 'abcdef' })).status, 200);
});

after(async () => {
  for (const a of apps) await a.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('setup solo una vez y login con 6 caracteres', async () => {
  const st = await admin.get('/api/status');
  assert.equal(st.data.needsSetup, false);
  const again = await client(base).post('/api/setup', { name: 'X', username: 'otro', password: '123456' });
  assert.equal(again.status, 403);
  const c = client(base);
  const wrong = await c.post('/api/login', { username: 'admin', password: '12345' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error, 'unauthorized');
  const ok = await c.post('/api/login', { username: 'ADMIN', password: '123456' });
  assert.equal(ok.status, 200);
  const state = await c.get('/api/state');
  assert.equal(state.data.user.username, 'admin');
});

test('validación de usuarios: contraseña corta, rol inválido y usuario repetido', async () => {
  assert.equal((await admin.post('/api/users', { name: 'A', username: 'corto', password: '12345', role: 'local' })).status, 400);
  assert.equal((await admin.post('/api/users', { name: 'A', username: 'rolx', password: '123456', role: 'jefe' })).status, 400);
  assert.equal((await admin.post('/api/users', { name: 'A', username: 'moto1', password: '123456', role: 'driver' })).status, 400);
  assert.equal((await local.post('/api/users', { name: 'A', username: 'nuevo', password: '123456', role: 'local' })).status, 403);
});

test('SETUP_TOKEN obligatorio cuando está definido', async () => {
  const { base: b } = await start({ SETUP_TOKEN: 'token-secreto' });
  const c = client(b);
  assert.deepEqual((await c.get('/api/status')).data, { needsSetup: true, setupTokenRequired: true });
  assert.equal((await c.post('/api/setup', { name: 'A', username: 'admin', password: '123456' })).status, 403);
  assert.equal((await c.post('/api/setup', { name: 'A', username: 'admin', password: '123456', setupToken: 'malo' })).status, 403);
  const ok = await c.post('/api/setup', { name: 'A', username: 'admin', password: '123456', setupToken: 'token-secreto' });
  assert.equal(ok.status, 200);
});

test('Origin incorrecto o ausente se rechaza; JSON inválido 400', async () => {
  const r1 = await local.post('/api/orders', { address: 'Calle 1' }, { origin: 'http://malo.example' });
  assert.equal(r1.status, 403);
  assert.equal(r1.data.error, 'bad_origin');
  const r2 = await local.post('/api/orders', { address: 'Calle 1' }, { noOrigin: '1' });
  assert.equal(r2.status, 403);
  const r3 = await local.post('/api/orders', { address: 'Calle 1' }, { noOrigin: '1', referer: `${ORIGIN}/panel` });
  assert.equal(r3.status, 200);
  const r4 = await local.post('/api/orders', '{malo');
  assert.equal(r4.status, 400);
  assert.equal(r4.data.error, 'bad_request');
  const big = await local.post('/api/orders', JSON.stringify({ address: 'x', notes: 'a'.repeat(300 * 1024) }));
  assert.equal(big.status, 413);
});

test('validación de pedido manual', async () => {
  assert.equal((await local.post('/api/orders', { customerName: 'Sin dirección' })).status, 400);
  assert.equal((await local.post('/api/orders', { address: 'A', deliveryFee: -1 })).status, 400);
  assert.equal((await local.post('/api/orders', { address: 'A', total: 10.5 })).status, 400);
  assert.equal((await local.post('/api/orders', { address: 'A', channel: 'fax' })).status, 400);
  assert.equal((await local.post('/api/orders', { address: 'A', lat: 120, lng: 0 })).status, 400);
  assert.equal((await local.post('/api/orders', { address: 'x'.repeat(301) })).status, 400);
  assert.equal((await d1.post('/api/orders', { address: 'A' })).status, 403);
  assert.equal((await client(base).post('/api/orders', { address: 'A' })).status, 401);
});

test('flujo completo manual y reglas de motorista', async () => {
  const created = await local.post('/api/orders', {
    channel: 'telefono', customerName: 'Ana <b>', customerPhone: '+56911112222', address: 'Ortúzar 123',
    deliveryFee: 2500, total: 15900, items: [{ name: 'Sushi', qty: 2 }],
  });
  assert.equal(created.status, 200);
  const o = created.data.order;
  assert.match(o.id, /^P-\d+$/);
  assert.equal(o.status, 'preparing');
  assert.equal(o.pickup, false);
  assert.deepEqual(o.items, [{ name: 'Sushi', qty: 2 }]);

  // Motorista no ve el pedido no asignado ni puede actuar.
  assert.equal((await d1.get('/api/state')).data.orders.some((x) => x.id === o.id), false);
  assert.equal((await d1.post('/api/action', { orderId: o.id, action: 'ready' })).status, 404);

  // Salida antes de listo: 409.
  const early = await local.post('/api/action', { orderId: o.id, action: 'depart' });
  assert.equal(early.status, 409);
  assert.equal(early.data.error, 'invalid_transition');

  const ready = await local.post('/api/action', { orderId: o.id, action: 'ready' });
  assert.equal(ready.data.order.status, 'ready');
  assert.ok(ready.data.order.readyAt);
  assert.equal((await local.post('/api/action', { orderId: o.id, action: 'ready' })).status, 409);

  // Listo sin motorista no puede salir.
  assert.equal((await local.post('/api/action', { orderId: o.id, action: 'depart' })).status, 409);
  assert.equal((await local.post('/api/action', { orderId: o.id, action: 'assign', driverId: 9999 })).status, 400);
  const asg = await local.post('/api/action', { orderId: o.id, action: 'assign', driverId: driver1Id });
  assert.equal(asg.data.order.driverId, driver1Id);
  assert.equal(asg.data.order.driverName, 'Jorge');

  // Motorista 1 lo ve (sin total), motorista 2 no.
  const s1 = await d1.get('/api/state');
  const mine = s1.data.orders.find((x) => x.id === o.id);
  assert.ok(mine);
  assert.equal('total' in mine, false);
  assert.equal(s1.data.metrics, null);
  assert.deepEqual(s1.data.users, []);
  assert.equal((await d2.get('/api/state')).data.orders.some((x) => x.id === o.id), false);
  assert.equal((await d2.post('/api/action', { orderId: o.id, action: 'depart' })).status, 404);
  assert.equal((await d2.get(`/api/qr?id=${o.id}`)).status, 404);

  // Motorista no puede cancelar ni asignar.
  assert.equal((await d1.post('/api/action', { orderId: o.id, action: 'cancel' })).status, 403);

  const dep = await d1.post('/api/action', { orderId: `DESPACHO:${o.id}`, action: 'depart' });
  assert.equal(dep.status, 200);
  assert.equal(dep.data.order.status, 'in_transit');
  // Reasignar tras salida: 409.
  assert.equal((await local.post('/api/action', { orderId: o.id, action: 'assign', driverId: driver2Id })).status, 409);
  // Local no puede entregar.
  assert.equal((await local.post('/api/action', { orderId: o.id, action: 'deliver' })).status, 403);
  // Incidencia sin nota: 400; con nota ok.
  assert.equal((await d1.post('/api/action', { orderId: o.id, action: 'incident' })).status, 400);
  const inc = await d1.post('/api/action', { orderId: o.id, action: 'incident', note: 'Portón cerrado' });
  assert.equal(inc.data.order.status, 'in_transit');
  assert.equal(inc.data.order.incidents[0].note, 'Portón cerrado');
  assert.equal(inc.data.order.incidents[0].by, 'Jorge');

  assert.equal((await d1.post('/api/action', { orderId: o.id, action: 'deliver', lat: 95, lng: 0 })).status, 400);
  const del = await d1.post('/api/action', { orderId: o.id, action: 'deliver', lat: -33.68, lng: -71.21, accuracy: 12 });
  assert.equal(del.status, 200);
  assert.equal(del.data.order.status, 'delivered');
  assert.ok(del.data.order.deliveredAt);
  assert.equal(del.data.order.deliveryLat, -33.68);
  const again = await d1.post('/api/action', { orderId: o.id, action: 'deliver' });
  assert.equal(again.status, 409);
  assert.equal((await local.post('/api/action', { orderId: o.id, action: 'cancel' })).status, 409);

  // Pedido inexistente y acción inválida.
  assert.equal((await local.post('/api/action', { orderId: 'P-999999', action: 'ready' })).status, 404);
  assert.equal((await local.post('/api/action', { orderId: o.id, action: 'volar' })).status, 400);
});

test('cancelar y fallar', async () => {
  const a = (await local.post('/api/orders', { address: 'Cancelado 1' })).data.order;
  const c = await local.post('/api/action', { orderId: a.id, action: 'cancel', note: 'Cliente desistió' });
  assert.equal(c.data.order.status, 'canceled');
  const b = (await local.post('/api/orders', { address: 'Fallido 1' })).data.order;
  await local.post('/api/action', { orderId: b.id, action: 'ready' });
  await local.post('/api/action', { orderId: b.id, action: 'assign', driverId: driver2Id });
  await d2.post('/api/action', { orderId: b.id, action: 'depart' });
  assert.equal((await d2.post('/api/action', { orderId: b.id, action: 'fail' })).status, 400);
  const f = await d2.post('/api/action', { orderId: b.id, action: 'fail', note: 'No contesta' });
  assert.equal(f.data.order.status, 'failed');
});

test('QR SVG autorizado, escapado y rechazos', async () => {
  const o = (await local.post('/api/orders', { customerName: 'Juan & <script>', address: 'Av. "Siempre" Viva 742' })).data.order;
  const r = await local.get(`/api/qr?id=${o.id}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(r.data, /<svg/);
  assert.ok(r.data.includes(o.id));
  assert.ok(r.data.includes('Juan &amp; &lt;script&gt;'));
  assert.ok(!r.data.includes('<script>'));
  assert.ok(r.data.includes('&quot;Siempre&quot;'));
  assert.equal((await client(base).get(`/api/qr?id=${o.id}`)).status, 401);
  assert.equal((await d1.get(`/api/qr?id=${o.id}`)).status, 404);
  assert.equal((await local.get('/api/qr?id=P-999999')).status, 404);
  assert.equal((await local.get('/api/qr')).status, 400);
});

test('webhook: sin secreto configurado, secreto malo, dedupe y orden', async () => {
  const { base: b } = await start({ MERCAT_WEBHOOK_SECRET: '' });
  const nc = await webhook(b, { event_id: 'x' });
  assert.equal(nc.status, 503);
  assert.equal(nc.data.error, 'not_configured');

  assert.equal((await webhook(base, { event_id: 'x' }, 'malo')).status, 401);
  assert.equal((await webhook(base, { event_id: 'x' }, null)).status, 401);

  const ev = (id, ts, data, type = 'orders.create') => ({
    event_id: id, event_type: type, event_timestamp: ts, api_version: '1', client_id: 'c',
    event_data: { id: 777, store_id: 'S1', ...data },
  });
  const t0 = Date.now() - 60000;
  const r1 = await webhook(base, ev('e1', new Date(t0).toISOString(), {
    status: 'preparing', user_name: 'Carla', user_phone: '+56922223333', user_address: 'Serrano 45',
    apartment: 'Depto 3', delivery_price: 2000, total: 12000, products: [{ name: 'Gyoza', quantity: 3 }],
    latitude: -33.69, longitude: -71.21,
  }));
  assert.equal(r1.status, 200);
  assert.deepEqual([r1.data.applied, r1.data.duplicate], [true, false]);
  const dup = await webhook(base, ev('e1', new Date(t0).toISOString(), { status: 'preparing' }));
  assert.deepEqual([dup.data.applied, dup.data.duplicate], [false, true]);

  // Evento más nuevo: ready remoto fija ready_at = event_timestamp.
  const tReady = new Date(t0 + 30000).toISOString();
  const r2 = await webhook(base, ev('e2', tReady, { status: 'ready' }, 'orders.update'));
  assert.equal(r2.data.applied, true);
  // Evento antiguo no pisa.
  const r3 = await webhook(base, ev('e3', new Date(t0 + 10000).toISOString(), { status: 'preparing', user_name: 'Viejo' }, 'orders.update'));
  assert.deepEqual([r3.data.applied, r3.data.duplicate], [false, false]);

  const st = await local.get('/api/state');
  const o = st.data.orders.find((x) => x.externalId === 'mercat:S1:777');
  assert.ok(o);
  assert.equal(o.source, 'mercat');
  assert.equal(o.channel, 'mercat');
  assert.equal(o.status, 'ready');
  assert.equal(o.externalStatus, 'ready');
  assert.equal(o.readyAt, tReady);
  assert.equal(o.customerName, 'Carla');
  assert.equal(o.addressDetail, 'Depto 3');
  assert.equal(o.deliveryFee, 2000);
  assert.deepEqual(o.items, [{ name: 'Gyoza', qty: 3 }]);
  assert.equal(o.createdAt, new Date(t0).toISOString()); // sin created_at se usa event_timestamp

  // completed no marca entrega local.
  const r4 = await webhook(base, ev('e4', new Date(t0 + 50000).toISOString(), { status: 'completed' }, 'orders.update'));
  assert.equal(r4.data.applied, true);
  const o2 = (await local.get('/api/state')).data.orders.find((x) => x.id === o.id);
  assert.equal(o2.status, 'ready');
  assert.equal(o2.deliveredAt, null);
  assert.equal(o2.externalStatus, 'completed');

  // Tipo de evento no soportado.
  const ign = await webhook(base, { event_id: 'e5', event_type: 'stores.update', event_timestamp: Date.now(), event_data: {} });
  assert.equal(ign.data.ignored, true);
  assert.equal(ign.data.applied, false);

  // Cancelación remota.
  await webhook(base, ev('e6', Date.now(), { id: 778, status: 'preparing', user_address: 'X 1' }));
  await webhook(base, ev('e7', Date.now() + 1000, { id: 778, status: 'cancelled' }, 'orders.update'));
  const o3 = (await local.get('/api/state')).data.orders.find((x) => x.externalId === 'mercat:S1:778');
  assert.equal(o3.status, 'canceled');

  // Sin event_id => 400.
  assert.equal((await webhook(base, { event_type: 'orders.create', event_timestamp: Date.now(), event_data: { id: 1 } })).status, 400);
});

test('pickup: no se asigna, no se despacha y queda fuera de métricas', async () => {
  const before = (await admin.get('/api/state')).data.metrics;
  const r = await webhook(base, {
    event_id: 'p1', event_type: 'orders.create', event_timestamp: Date.now(),
    event_data: { id: 900, store_id: 'S1', status: 'ready', delivery_type: 'pickup', user_name: 'Retira' },
  });
  assert.equal(r.data.applied, true);
  const o = (await local.get('/api/state')).data.orders.find((x) => x.externalId === 'mercat:S1:900');
  assert.equal(o.pickup, true);
  assert.equal(o.status, 'ready');
  const asg = await local.post('/api/action', { orderId: o.id, action: 'assign', driverId: driver1Id });
  assert.equal(asg.status, 409);
  assert.equal((await local.post('/api/action', { orderId: o.id, action: 'depart' })).status, 409);
  const afterM = (await admin.get('/api/state')).data.metrics;
  assert.deepEqual(afterM.byChannel, before.byChannel);
  assert.equal(afterM.prep.count, before.prep.count);
});

test('métricas: counts, filtros y día Chile', async () => {
  const today = chileDay(new Date());
  const st = await admin.get(`/api/state?from=${today}&to=${today}`);
  const m = st.data.metrics;
  assert.equal(m.from, today);
  assert.equal(m.to, today);
  // Pedidos de hoy creados en otras pruebas: 1 entregado, 1 fallido, 2 cancelados (manual + Mercat).
  assert.equal(m.deliveredCount, 1);
  assert.equal(m.failedCount, 1);
  assert.equal(m.canceledCount, 2);
  assert.equal(m.total.count, 1);
  assert.equal(m.route.count, 1);
  assert.ok(m.wait.count >= 2);
  assert.ok(m.prep.count >= 3);
  assert.ok(m.total.avgMinutes >= 0);
  assert.deepEqual(m.byDriver.map((d) => [d.driverId, d.deliveries]), [[driver1Id, 1]]);
  const tel = m.byChannel.find((c) => c.channel === 'telefono');
  assert.equal(tel.orders, 1);

  const byD = (await admin.get(`/api/state?driverId=${driver2Id}`)).data.metrics;
  assert.equal(byD.deliveredCount, 0);
  assert.equal(byD.failedCount, 1);

  assert.equal((await admin.get('/api/state?from=2026-13-01')).status, 400);
  assert.equal((await admin.get('/api/state?from=2026-10-10&to=2026-10-01')).status, 400);

  // 2026-10-20T02:30Z es 2026-10-19 en Chile (UTC-3).
  await webhook(base, {
    event_id: 'old1', event_type: 'orders.create', event_timestamp: '2026-10-20T02:40:00Z',
    event_data: { id: 500, store_id: 'S9', status: 'ready', created_at: '2026-10-20T02:30:00Z', user_address: 'Y 2' },
  });
  const d19 = (await admin.get('/api/state?from=2026-10-19&to=2026-10-19&branch=S9')).data.metrics;
  assert.equal(d19.prep.count, 1);
  assert.equal(d19.prep.avgMinutes, 10);
  const d20 = (await admin.get('/api/state?from=2026-10-20&to=2026-10-20&branch=S9')).data.metrics;
  assert.equal(d20.prep.count, 0);
  assert.ok((await admin.get('/api/state')).data.branches.includes('S9'));

  // Local ve métricas pero no costos ni usuarios.
  const ls = (await local.get('/api/state')).data;
  assert.ok(ls.metrics);
  assert.equal(ls.costs, null);
  assert.deepEqual(ls.users, []);
  assert.ok(ls.drivers.some((d) => d.id === driver1Id));
});

test('costos por mes, historial y costPerDelivery', async () => {
  const month = chileDay(new Date()).slice(0, 7);
  assert.equal((await admin.post('/api/settings', { month, labor: -1 })).status, 400);
  assert.equal((await admin.post('/api/settings', { month: '2026-13', labor: 1 })).status, 400);
  assert.equal((await local.post('/api/settings', { month, labor: 1 })).status, 403);
  const r = await admin.post('/api/settings', { month, labor: 100000, fuel: 20000, maintenance: 5000, insurance: 0, other: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.data.costs.totalCost, 125000);
  assert.equal(r.data.costs.deliveredInMonth, 1);
  assert.equal(r.data.costs.costPerDelivery, 125000);
  assert.equal(r.data.costs.feesInMonth, 2500);
  assert.equal(r.data.costs.feesMinusCost, 2500 - 125000);

  await admin.post('/api/settings', { month: '2025-01', labor: 7, fuel: 0, maintenance: 0, insurance: 0, other: 0 });
  const old = (await admin.get('/api/state?costMonth=2025-01')).data.costs;
  assert.equal(old.totalCost, 7);
  assert.equal(old.deliveredInMonth, 0);
  assert.equal(old.costPerDelivery, null);
  const cur = (await admin.get('/api/state')).data.costs;
  assert.equal(cur.month, month);
  assert.equal(cur.totalCost, 125000);
});

test('export CSV solo admin', async () => {
  assert.equal((await local.get('/api/export.csv')).status, 403);
  const r = await admin.get('/api/export.csv');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/csv/);
  const lines = r.data.replace(/^﻿/, '').trim().split('\r\n');
  assert.ok(lines[0].startsWith('id;fecha;'));
  assert.ok(lines.length >= 5);
  assert.ok(lines.some((l) => l.includes('Ortúzar 123') && l.includes(';delivered;')));
  assert.ok(!r.data.includes('Retira'), 'pickup excluido');
});

test('desactivar usuario cierra su sesión y bloquea login', async () => {
  const c = client(base);
  const u = await admin.post('/api/users', { name: 'Temporal', username: 'temp1', password: 'qwerty', role: 'driver' });
  assert.equal((await c.post('/api/login', { username: 'temp1', password: 'qwerty' })).status, 200);
  assert.equal((await c.get('/api/state')).status, 200);
  const upd = await admin.post('/api/users/update', { id: u.data.user.id, active: false });
  assert.equal(upd.data.user.active, false);
  assert.equal((await c.get('/api/state')).status, 401);
  assert.equal((await c.post('/api/login', { username: 'temp1', password: 'qwerty' })).status, 401);
  // No puede desactivarse a sí mismo.
  const me = (await admin.get('/api/state')).data.user.id;
  assert.equal((await admin.post('/api/users/update', { id: me, active: false })).status, 400);
  // Cambio de contraseña con mínimo 6.
  assert.equal((await admin.post('/api/users/update', { id: u.data.user.id, password: '123' })).status, 400);
});

test('logout y rate limit de login', async () => {
  const c = client(base);
  await c.post('/api/login', { username: 'local1', password: 'abcdef' });
  assert.equal((await c.post('/api/logout')).status, 200);
  assert.equal((await c.get('/api/state')).status, 401);
  for (let i = 0; i < 10; i++) {
    assert.equal((await c.post('/api/login', { username: 'moto2', password: 'malamala' })).status, 401);
  }
  const blocked = await c.post('/api/login', { username: 'moto2', password: 'abcdef' });
  assert.equal(blocked.status, 429);
});

test('estáticos: cabeceras de seguridad y sin path traversal', async () => {
  const r = await fetch(`${base}/../server.mjs`);
  assert.notEqual(r.status, 200);
  const r2 = await fetch(`${base}/%2e%2e/server.mjs`);
  assert.equal(r2.status, 404);
  const r3 = await fetch(`${base}/api/status`);
  assert.equal(r3.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r3.headers.get('content-security-policy'), /img-src 'self' data:/);
  assert.ok(r3.headers.get('referrer-policy'));
  assert.equal((await fetch(`${base}/api/nada`)).status, 404);
});

test('cookie Secure según el origen https cuando hay varios PUBLIC_ORIGIN', async () => {
  const { base: b } = await start({ PUBLIC_ORIGIN: 'http://10.0.2.2:4317, HTTPS://Despachos.Example:443/' });
  const c = client(b);
  const s = await c.post('/api/setup', { name: 'A', username: 'admin', password: '123456' }, { origin: 'https://despachos.example' });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.match(s.headers.get('set-cookie'), /; Secure/);
  const l = await client(b).post('/api/login', { username: 'admin', password: '123456' }, { origin: 'http://10.0.2.2:4317' });
  assert.equal(l.status, 200);
  assert.doesNotMatch(l.headers.get('set-cookie'), /Secure/);
  const out = await c.post('/api/logout', {}, { origin: 'https://despachos.example' });
  assert.match(out.headers.get('set-cookie'), /; Secure/);
});

test('SETUP_TOKEN con límite de intentos', async () => {
  const { base: b } = await start({ SETUP_TOKEN: 'token-largo-1' });
  const c = client(b);
  for (let i = 0; i < 10; i++) {
    assert.equal((await c.post('/api/setup', { name: 'A', username: 'admin', password: '123456', setupToken: `malo${i}` })).status, 403);
  }
  const r = await c.post('/api/setup', { name: 'A', username: 'admin', password: '123456', setupToken: 'token-largo-1' });
  assert.equal(r.status, 429);
});

test('hora Chile sin zona en el salto a horario de verano (septiembre)', async () => {
  const send = (id, created) => webhook(base, {
    event_id: `dst-${id}`, event_type: 'orders.create', event_timestamp: '2026-09-06T05:00:00Z',
    event_data: { id, store_id: 'DST', status: 'ready', created_at: created, user_address: 'Z 1' },
  });
  // 00:30 del 6-sep no existe en Chile (de 24:00 se pasa a 01:00): se lleva a 01:30 (-03), mismo día.
  for (const [id, created, iso] of [
    [1, '2026-09-06 00:30', '2026-09-06T04:30:00.000Z'],
    [2, '2026-09-06 01:30', '2026-09-06T04:30:00.000Z'],
    [3, '2026-09-05 23:30', '2026-09-06T03:30:00.000Z'],
    [4, '2026-04-05 00:30', '2026-04-05T04:30:00.000Z'],
  ]) {
    const r = await webhook(base, { event_id: `dst-x${id}`, event_type: 'orders.create', event_timestamp: Date.parse(iso) + 60000,
      event_data: { id: `x${id}`, store_id: 'DST', created_at: created, user_address: 'Z 1' } });
    assert.equal(r.status, 200);
    const row = apps[0].db.prepare('SELECT created_at FROM orders WHERE id = ?').get(r.data.orderId);
    assert.equal(row.created_at, iso, created);
  }
  // Pedido listo creado a las "00:10" del día del cambio: cuenta para el 6-sep, no para el 5-sep.
  assert.equal((await send(10, '2026-09-06 00:10')).status, 200);
  const day = async (d) => (await admin.get(`/api/state?from=${d}&to=${d}&branch=DST`)).data.metrics.prep;
  assert.deepEqual(await day('2026-09-06'), { avgMinutes: 50, count: 1 });
  assert.equal((await day('2026-09-05')).count, 0);
});
