// Panel de despachos Osake (Melipilla). Sin frameworks ni dependencias.
// Todo el contenido del servidor se inserta con textContent / createElement.
'use strict';

(() => {
  const TZ = 'America/Santiago';
  const REFRESH_MS = 15000;
  const GEO_TIMEOUT_MS = 8000;

  const STATUS_LABEL = {
    preparing: 'En preparación',
    ready: 'Listo para salir',
    in_transit: 'En ruta',
    delivered: 'Entregado',
    canceled: 'Cancelado',
    failed: 'No entregado',
  };
  const CHANNEL_LABEL = { meson: 'Mesón', telefono: 'Teléfono', mercat: 'Mercat', otro: 'Otro' };
  const ROLE_LABEL = { admin: 'Administración', local: 'Local', driver: 'Motorista' };
  const ACTIVE_STATUSES = ['preparing', 'ready', 'in_transit'];
  const CLOSED_STATUSES = ['delivered', 'failed', 'canceled'];

  const clp = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' });
  const dec1 = new Intl.NumberFormat('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const intFmt = new Intl.NumberFormat('es-CL');
  const timeFmt = new Intl.DateTimeFormat('es-CL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dateTimeFmt = new Intl.DateTimeFormat('es-CL', {
    timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const partsFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });

  // ---------- Estado ----------
  const app = {
    data: null,           // última respuesta de /api/state
    clockOffset: 0,       // serverTime - Date.now()
    filters: { from: '', to: '', branch: '', driverId: '', costMonth: '' },
    tab: 'orders',
    refreshing: null,     // promesa del refresco en curso
    openGroups: new Set(), // grupos <details> abiertos en la lista de pedidos
    timer: null,
    costsFilledFor: null,
    metricsFilled: false,
    batch: new Set(),     // ids de pedidos listos seleccionados para la próxima salida (motorista)
  };
  const BATCH_MAX = 20;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------- Utilidades DOM ----------
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k in node && typeof v !== 'string') node[k] = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function show(node, visible) { if (node) node.hidden = !visible; }

  // ---------- Formato ----------
  const money = (n) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? '—' : clp.format(Number(n)));
  const minutes = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : `${dec1.format(Number(n))} min`);
  const plural = (n, one, many) => `${intFmt.format(n)} ${n === 1 ? one : many}`;
  const meters = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '—'
    : Number(n) < 1000 ? `${intFmt.format(Math.round(Number(n)))} m` : `${dec1.format(Number(n) / 1000)} km`);
  const hhmm = (iso) => (iso ? timeFmt.format(new Date(iso)) : '');
  const ddhhmm = (iso) => (iso ? dateTimeFmt.format(new Date(iso)) : '');
  const chileDate = (msOrIso) => ymdFmt.format(new Date(msOrIso));
  const serverNow = () => Date.now() + app.clockOffset;

  function ago(iso) {
    if (!iso) return '';
    const mins = Math.floor((serverNow() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'hace menos de 1 min';
    if (mins < 60) return `hace ${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `hace ${h} h ${m} min` : `hace ${h} h`;
  }

  function tzOffsetMs(ms) {
    const p = {};
    for (const part of partsFmt.formatToParts(new Date(ms))) p[part.type] = part.value;
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
  }
  // Convierte fecha (YYYY-MM-DD) + hora (HH:MM) de Santiago a ISO UTC.
  function santiagoToIso(ymd, hm) {
    const [y, mo, d] = ymd.split('-').map(Number);
    const [h, mi] = hm.split(':').map(Number);
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    const offA = tzOffsetMs(guess);
    const offB = tzOffsetMs(guess - offA);
    let ts = guess - offB;
    // Hora inexistente por el cambio a horario de verano: se lleva hacia adelante (igual que el servidor).
    if (ts + tzOffsetMs(ts) !== guess) ts = guess - Math.min(offA, offB);
    return new Date(ts).toISOString();
  }
  function promisedFromTime(hm) {
    if (!hm) return null;
    const now = serverNow();
    let iso = santiagoToIso(chileDate(now), hm);
    // Si la hora quedó más de 2 h en el pasado, se asume el día siguiente (pedidos pasada la medianoche).
    if (new Date(iso).getTime() < now - 2 * 3600 * 1000) {
      iso = santiagoToIso(chileDate(now + 24 * 3600 * 1000), hm);
    }
    return iso;
  }

  // ---------- Mensajes ----------
  function notify(message, type = 'info', ms) {
    const region = type === 'error' ? $('#toast-alert') : $('#toast-status');
    const t = el('div', { class: `toast toast-${type}` },
      el('span', { class: 'toast-text', text: message }),
      el('button', { type: 'button', class: 'toast-close', 'aria-label': 'Cerrar aviso', text: '×', on: { click: () => t.remove() } }));
    region.append(t);
    setTimeout(() => t.remove(), ms || (type === 'error' ? 10000 : 6000));
  }

  function setOffline(off) {
    show($('#offline'), off);
    document.body.classList.toggle('is-offline', off);
  }

  // ---------- API ----------
  class ApiError extends Error {
    constructor(message, status, code, data = null) { super(message); this.status = status; this.code = code; this.data = data; }
  }

  async function api(path, { method = 'GET', body, authRedirect = true } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      setOffline(true);
      throw new ApiError('Sin conexión con el servidor. Revisa tu conexión e intenta de nuevo.', 0, 'offline');
    }
    setOffline(false);
    let data = null;
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      try { data = await res.json(); } catch { data = null; }
    }
    if (!res.ok) {
      const msg = (data && data.message) || `Error del servidor (${res.status}).`;
      const err = new ApiError(msg, res.status, data && data.error, data);
      if (res.status === 401 && authRedirect) handleUnauthorized();
      throw err;
    }
    return data;
  }

  function handleUnauthorized() {
    const wasLogged = !!app.data;
    app.data = null;
    closeDialog();
    showLogin();
    if (wasLogged) notify('Tu sesión terminó. Ingresa de nuevo.', 'info');
  }

  // ---------- Vistas ----------
  const VIEWS = ['loading', 'setup', 'login', 'admin', 'driver'];
  function showView(name) {
    for (const v of VIEWS) show($(`#view-${v}`), v === name);
    const logged = name === 'admin' || name === 'driver';
    show($('#topbar-user'), logged);
    show($('#btn-logout'), logged);
    show($('#btn-refresh'), logged);
    updateAndroidButtons(logged);
  }

  function hasAndroid() {
    return typeof window.AndroidApp === 'object' && window.AndroidApp !== null;
  }
  function updateAndroidButtons(logged) {
    const android = hasAndroid();
    show($('#btn-server'), android && typeof window.AndroidApp.openSettings === 'function');
    const canScan = android && typeof window.AndroidApp.scan === 'function';
    for (const b of $$('[data-android-scan]')) show(b, canScan);
  }

  function showSetup(tokenRequired) {
    showView('setup');
    show($('#setup-token-field'), !!tokenRequired);
    $('#setup-token').required = !!tokenRequired;
    $('#setup-name').focus();
  }
  function showLogin() {
    showView('login');
    stopTimer();
    const u = $('#login-username');
    if (u && !u.value) u.focus(); else $('#login-password').focus();
  }

  // ---------- Refresco ----------
  const dirtyFields = new WeakSet();
  document.addEventListener('input', (e) => {
    const t = e.target;
    // Las casillas de selección de salida guardan su estado en app.batch: no deben frenar el refresco.
    if (t instanceof HTMLElement && t.matches('input, textarea, select') && t.type !== 'checkbox') {
      dirtyFields.add(t);
      const form = t.closest('form');
      if (form) form.dataset.dirty = '1';
    }
  }, true);
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && t.matches('select')) dirtyFields.add(t);
  }, true);

  function isEditing() {
    if (document.querySelector('dialog[open]')) return true;
    const a = document.activeElement;
    if (a && a.matches && a.matches('input, textarea, select')) {
      if (dirtyFields.has(a) && (a.tagName === 'SELECT' || String(a.value || '').trim() !== '')) return true;
    }
    return false;
  }

  function stateQuery() {
    const q = new URLSearchParams();
    const f = app.filters;
    if (f.from) q.set('from', f.from);
    if (f.to) q.set('to', f.to);
    if (f.branch) q.set('branch', f.branch);
    if (f.driverId) q.set('driverId', f.driverId);
    if (f.costMonth) q.set('costMonth', f.costMonth);
    const s = q.toString();
    return s ? `?${s}` : '';
  }

  // Un refresco forzado (tras una acción o un escaneo) espera al que esté en curso y vuelve a pedir
  // el estado; si no, la respuesta en curso (anterior a la acción) dejaría la pantalla desactualizada.
  async function refresh({ force = false } = {}) {
    if (app.refreshing && !force) return false;
    while (app.refreshing) await app.refreshing;
    if (!force && isEditing()) return false;
    const run = doRefresh();
    app.refreshing = run;
    try { return await run; } finally { if (app.refreshing === run) app.refreshing = null; }
  }

  async function doRefresh() {
    try {
      const data = await api(`/api/state${stateQuery()}`);
      if (!data || !data.user) throw new ApiError('Respuesta inesperada del servidor.', 500);
      const st = data.serverTime ? new Date(data.serverTime).getTime() : NaN;
      app.clockOffset = Number.isFinite(st) ? st - Date.now() : 0;
      app.data = data;
      render();
      startTimer();
      return true;
    } catch (err) {
      if (err.status !== 401 && err.code !== 'offline') notify(err.message, 'error');
      if (err.code === 'offline' && !app.data) {
        showView('loading');
        $('#loading-text').textContent = 'No se pudo conectar con el servidor.';
        show($('#btn-retry'), true);
      }
      return false;
    }
  }

  function startTimer() {
    if (app.timer) return;
    app.timer = setInterval(() => {
      if (document.hidden || !app.data) return;
      refresh();
    }, REFRESH_MS);
  }
  function stopTimer() {
    if (app.timer) clearInterval(app.timer);
    app.timer = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && app.data) refresh();
  });
  window.addEventListener('online', () => { if (app.data) refresh(); else boot(); });
  window.addEventListener('offline', () => setOffline(true));

  // ---------- Render principal ----------
  function role() { return app.data && app.data.user ? app.data.user.role : null; }
  const isAdmin = () => role() === 'admin';
  const isStaff = () => role() === 'admin' || role() === 'local';
  const isDriver = () => role() === 'driver';

  function render() {
    const d = app.data;
    if (!d) return;
    $('#user-label').textContent = `${d.user.name} · ${ROLE_LABEL[d.user.role] || d.user.role}`;
    if (isDriver()) {
      showView('driver');
      renderDriver();
    } else {
      showView('admin');
      for (const n of $$('[data-admin-only]')) show(n, isAdmin());
      if (!isAdmin() && (app.tab === 'costs' || app.tab === 'users')) app.tab = 'orders';
      selectTab(app.tab, false);
      renderOrders();
      renderBranchesAndDrivers();
      renderMetrics();
      if (isAdmin()) { renderCosts(); renderUsers(); }
    }
  }

  // ---------- Pestañas ----------
  function selectTab(name, focus) {
    app.tab = name;
    try { sessionStorage.setItem('despachos-tab', name); } catch { /* sin almacenamiento */ }
    for (const t of $$('.tab')) {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    }
    for (const p of $$('.tab-panel')) show(p, p.dataset.panel === name);
    if (focus) {
      const panel = $(`#tab-${name}`);
      const first = panel && panel.querySelector('input, select, textarea, button');
      if (first && name !== 'orders') first.focus();
    }
  }
  for (const t of $$('.tab')) t.addEventListener('click', () => selectTab(t.dataset.tab, true));
  try {
    const saved = sessionStorage.getItem('despachos-tab');
    if (saved) app.tab = saved;
  } catch { /* sin almacenamiento */ }

  // ---------- Tarjetas de pedido ----------
  function orderSummary(o, { compact = false } = {}) {
    const box = el('div', { class: 'order-summary' });
    box.append(el('p', { class: 'order-address' },
      o.address || 'Sin dirección',
      o.addressDetail ? el('span', { class: 'order-detail', text: ` · ${o.addressDetail}` }) : null));
    const who = [o.customerName, o.customerPhone].filter(Boolean).join(' · ');
    if (who) box.append(el('p', { class: 'order-customer', text: who }));
    if (Array.isArray(o.items) && o.items.length) {
      const txt = o.items.map((i) => `${i.qty || 1}× ${i.name}`).join(', ');
      box.append(el('p', { class: 'order-items', text: txt }));
    }
    if (o.notes) box.append(el('p', { class: 'order-notes', text: `Nota: ${o.notes}` }));
    if (!compact && Array.isArray(o.incidents) && o.incidents.length) {
      const ul = el('ul', { class: 'incidents', 'aria-label': 'Incidencias' });
      for (const inc of o.incidents) {
        ul.append(el('li', null, el('span', { class: 'muted', text: `${hhmm(inc.at)} ${inc.by || ''}: ` }), inc.note || ''));
      }
      box.append(ul);
    }
    return box;
  }

  function timeLine(o) {
    const parts = [];
    switch (o.status) {
      case 'preparing': parts.push(`Creado ${ago(o.createdAt)}`); break;
      case 'ready': parts.push(`Listo ${ago(o.readyAt || o.createdAt)}`); break;
      case 'in_transit': parts.push(`Salió ${ago(o.departedAt)}`); break;
      case 'delivered': parts.push(`Entregado a las ${hhmm(o.deliveredAt)}`); break;
      default: parts.push(`Creado ${ddhhmm(o.createdAt)}`);
    }
    if (o.promisedAt && ACTIVE_STATUSES.includes(o.status)) {
      parts.push(`prometido ${hhmm(o.promisedAt)}`);
    }
    return parts.join(' · ');
  }
  function isLate(o) {
    return !!(o.promisedAt && ACTIVE_STATUSES.includes(o.status) && new Date(o.promisedAt).getTime() < serverNow());
  }

  function cardHeader(o) {
    return el('div', { class: 'card-head' },
      el('strong', { class: 'order-id', text: o.id }),
      el('span', { class: `badge badge-${o.status}`, text: STATUS_LABEL[o.status] || o.status }),
      o.pickup ? el('span', { class: 'badge badge-pickup', text: 'Retiro en local' }) : null,
      o.channel ? el('span', { class: 'badge badge-soft', text: CHANNEL_LABEL[o.channel] || o.channel }) : null,
      isLate(o) ? el('span', { class: 'badge badge-late', text: 'Atrasado' }) : null,
      o.status === 'in_transit' && o.tripId ? el('span', { class: 'badge badge-soft', text: 'Salida en lote' }) : null,
      isStaff() && hasLocationFlag(o) ? el('span', { class: 'badge badge-warn', text: 'Revisar ubicación' }) : null);
  }

  // Entrega con observación de ubicación: lejos del destino, sin ubicación o en ráfaga.
  function hasLocationFlag(o) {
    return o.status === 'delivered' && (o.deliveryCheck === 'far' || o.deliveryCheck === 'no_location' || !!o.deliveryBurst);
  }
  const warnMeters = () => (app.data && Number(app.data.deliveryWarnMeters)) || 300;
  function locationText(o) {
    const parts = [];
    switch (o.deliveryCheck) {
      case 'ok': parts.push(`Ubicación OK: a ${meters(o.deliveryDistanceM)} del destino`); break;
      case 'far': {
        let t = `Lejos del destino: a ${meters(o.deliveryDistanceM)}`;
        if (o.deliveryAccuracy !== null && o.deliveryAccuracy !== undefined && Number(o.deliveryAccuracy) > warnMeters()) {
          t += ` (GPS impreciso, ±${meters(o.deliveryAccuracy)})`;
        }
        parts.push(t);
        break;
      }
      case 'no_location': parts.push('Entregado sin ubicación del motorista'); break;
      case 'no_destination': parts.push('Sin coordenadas de destino: no se pudo comparar'); break;
      default: break;
    }
    if (o.deliveryBurst) parts.push('ráfaga: marcado a menos de 1 min de otra entrega del motorista');
    return parts.join(' · ');
  }
  function locationLine(o) {
    if (o.status !== 'delivered') return null;
    const txt = locationText(o);
    return txt ? el('p', { class: `order-loc${hasLocationFlag(o) ? ' loc-warn' : ''}`, text: txt }) : null;
  }

  function actionBtn(label, fn, cls = '') {
    return el('button', { type: 'button', class: `btn ${cls}`.trim(), text: label, on: { click: fn } });
  }
  function qrLink(o) {
    return el('a', {
      class: 'btn', href: `/api/qr?id=${encodeURIComponent(o.id)}`, target: '_blank', rel: 'noopener',
      text: 'Etiqueta QR', 'aria-label': `Imprimir etiqueta QR del pedido ${o.id} (abre ventana nueva)`,
    });
  }

  function staffActions(o) {
    const box = el('div', { class: 'actions' });
    if (o.pickup) {
      box.append(el('p', { class: 'muted small', text: 'Retiro en local: sin acciones de despacho.' }));
      return box;
    }
    const s = o.status;
    if (s === 'preparing') box.append(actionBtn('Marcar listo', () => flowReady(o), 'btn-primary'));
    if (s === 'ready' && o.driverId) box.append(actionBtn('Registrar salida', () => flowDepart(o), 'btn-primary'));
    if (s === 'preparing' || s === 'ready') box.append(actionBtn(o.driverId ? 'Reasignar' : 'Asignar motorista', () => flowAssign(o), s === 'ready' && !o.driverId ? 'btn-primary' : ''));
    if (s === 'in_transit' && isAdmin()) {
      box.append(actionBtn('Entregado', () => flowDeliver(o), 'btn-success'));
      box.append(actionBtn('No entregado', () => flowFail(o), 'btn-danger-soft'));
    }
    if (s === 'ready' || s === 'in_transit') box.append(actionBtn('Incidencia', () => flowIncident(o)));
    if (s === 'preparing' || s === 'ready') box.append(actionBtn('Cancelar', () => flowCancel(o), 'btn-danger-soft'));
    box.append(qrLink(o));
    return box;
  }

  function staffCard(o) {
    const card = el('article', { class: `card order-card status-${o.status}${isLate(o) ? ' is-late' : ''}`, dataset: { id: o.id } });
    card.append(cardHeader(o));
    card.append(el('p', { class: 'order-time', text: timeLine(o) }));
    card.append(orderSummary(o));
    const driverTxt = o.pickup ? null : (o.driverName ? `Motorista: ${o.driverName}` : 'Sin motorista asignado');
    const money1 = [];
    if (o.total !== null && o.total !== undefined) money1.push(`Total ${money(o.total)}`);
    if (o.deliveryFee !== null && o.deliveryFee !== undefined) money1.push(`Delivery ${money(o.deliveryFee)}`);
    card.append(el('p', { class: 'order-meta' },
      driverTxt ? el('span', { class: o.driverName ? '' : 'warn-text', text: driverTxt }) : null,
      money1.length ? el('span', { class: 'muted', text: money1.join(' · ') }) : null,
      o.tripId ? el('span', { class: 'muted', text: `Vuelta ${o.tripId}` }) : null));
    const loc = locationLine(o);
    if (loc) card.append(loc);
    card.append(staffActions(o));
    return card;
  }

  function renderOrders() {
    const box = clear($('#orders-list'));
    const orders = (app.data.orders || []).slice();
    const dispatch = orders.filter((o) => !o.pickup);
    const pickups = orders.filter((o) => o.pickup);
    const byStatus = (s) => dispatch.filter((o) => o.status === s)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    let any = false;
    for (const s of ACTIVE_STATUSES) {
      const list = byStatus(s);
      const sec = el('section', { class: `group group-${s}`, 'aria-label': STATUS_LABEL[s] });
      sec.append(el('h2', { class: 'group-title' }, STATUS_LABEL[s], el('span', { class: 'count', text: ` (${list.length})` })));
      if (!list.length) sec.append(el('p', { class: 'muted empty', text: 'Sin pedidos.' }));
      for (const o of list) { sec.append(staffCard(o)); any = true; }
      box.append(sec);
    }
    const closed = dispatch.filter((o) => CLOSED_STATUSES.includes(o.status))
      .sort((a, b) => String(b.deliveredAt || b.createdAt).localeCompare(String(a.deliveredAt || a.createdAt)));
    if (closed.length) {
      const det = groupDetails('closed',
        el('summary', { class: 'group-title' }, 'Cerrados últimas 24 h', el('span', { class: 'count', text: ` (${closed.length})` })));
      for (const o of closed) det.append(staffCard(o));
      box.append(det);
    }
    if (pickups.length) {
      const det = groupDetails('pickup',
        el('summary', { class: 'group-title' }, 'Retiro en local (no se despachan)', el('span', { class: 'count', text: ` (${pickups.length})` })));
      for (const o of pickups) det.append(staffCard(o));
      box.append(det);
    }
    if (!any && !closed.length) box.prepend(el('p', { class: 'muted', text: 'No hay pedidos activos.' }));
  }

  // <details> que conserva su estado abierto entre refrescos (la lista se reconstruye cada 15 s).
  function groupDetails(key, summary) {
    const det = el('details', { class: `group group-${key}`, open: app.openGroups.has(key) }, summary);
    det.addEventListener('toggle', () => { if (det.open) app.openGroups.add(key); else app.openGroups.delete(key); });
    return det;
  }

  function setOptions(select, options, keepValue = true) {
    const prev = select.value;
    const first = select.options[0] && select.options[0].value === '' ? select.options[0].cloneNode(true) : null;
    clear(select);
    if (first) select.append(first);
    for (const [value, label] of options) select.append(el('option', { value: String(value), text: label }));
    if (keepValue && Array.from(select.options).some((o) => o.value === prev)) select.value = prev;
  }

  function renderBranchesAndDrivers() {
    const branches = app.data.branches || [];
    const dl = clear($('#branches-list'));
    for (const b of branches) dl.append(el('option', { value: b }));
    const mb = $('#m-branch');
    if (document.activeElement !== mb) setOptions(mb, branches.map((b) => [b, b]));
    const filtersDirty = !!$('#form-metrics').dataset.dirty;
    if (app.filters.branch && !filtersDirty) mb.value = app.filters.branch;
    const md = $('#m-driver');
    if (document.activeElement !== md) setOptions(md, (app.data.drivers || []).map((d) => [d.id, d.active ? d.name : `${d.name} (inactivo)`]));
    if (app.filters.driverId && !filtersDirty) md.value = app.filters.driverId;
  }

  // ---------- Métricas ----------
  function metricTile(title, sub, m) {
    const count = m && Number.isFinite(Number(m.count)) ? Number(m.count) : 0;
    const val = m && count > 0 ? minutes(m.avgMinutes) : '—';
    return el('div', { class: 'tile' },
      el('p', { class: 'tile-title', text: title }),
      el('p', { class: 'tile-value', text: val }),
      el('p', { class: 'tile-sub', text: `${sub} · ${plural(count, 'pedido', 'pedidos')}` }));
  }

  function renderMetrics() {
    const m = app.data.metrics;
    const box = clear($('#metrics-view'));
    if (!m) { box.append(el('p', { class: 'muted', text: 'Sin métricas disponibles.' })); return; }
    const form = $('#form-metrics');
    if (!form.dataset.dirty) {
      if (m.from) $('#m-from').value = m.from;
      if (m.to) $('#m-to').value = m.to;
    }
    updateExportLink();

    box.append(el('p', { class: 'muted', text: `Período: ${m.from || '—'} a ${m.to || '—'} (fecha de creación, hora Chile).` }));
    box.append(el('div', { class: 'tiles' },
      metricTile('Preparación', 'creado → listo', m.prep),
      metricTile('Espera de salida', 'listo → salida', m.wait),
      metricTile('Ruta', 'salida → entrega', m.route),
      metricTile('Total', 'creado → entrega', m.total)));
    box.append(el('div', { class: 'tiles tiles-counters' },
      counterTile('Entregados', m.deliveredCount),
      counterTile('No entregados', m.failedCount),
      counterTile('Cancelados', m.canceledCount),
      locationTile(m)));

    const drivers = m.byDriver || [];
    box.append(el('h3', { text: 'Por motorista' }));
    if (!drivers.length) box.append(el('p', { class: 'muted', text: 'Sin entregas en el período.' }));
    else {
      box.append(table(['Motorista', 'Entregas', 'Ruta promedio'],
        drivers.map((r) => [r.name || `#${r.driverId}`, intFmt.format(r.deliveries || 0), minutes(r.routeAvgMinutes)])));
    }
    const channels = m.byChannel || [];
    box.append(el('h3', { text: 'Por canal' }));
    if (!channels.length) box.append(el('p', { class: 'muted', text: 'Sin pedidos en el período.' }));
    else {
      box.append(table(['Canal', 'Pedidos', 'Total promedio'],
        channels.map((r) => [CHANNEL_LABEL[r.channel] || r.channel, intFmt.format(r.orders || 0), minutes(r.totalAvgMinutes)])));
    }
  }
  function counterTile(title, n) {
    return el('div', { class: 'tile tile-counter' },
      el('p', { class: 'tile-title', text: title }),
      el('p', { class: 'tile-value', text: intFmt.format(Number(n) || 0) }));
  }
  function locationTile(m) {
    const c = m.locationChecks || {};
    const n = (k) => intFmt.format(Number(c[k]) || 0);
    return el('div', { class: `tile tile-counter${Number(m.locationFlaggedCount) > 0 ? ' tile-warn' : ''}` },
      el('p', { class: 'tile-title', text: 'Entregas con observación de ubicación' }),
      el('p', { class: 'tile-value', text: intFmt.format(Number(m.locationFlaggedCount) || 0) }),
      el('p', { class: 'tile-sub', text: `lejos ${n('far')} · sin ubicación ${n('noLocation')} · ráfaga ${n('burst')} · sin destino ${n('noDestination')} (no verificable)` }));
  }
  function table(headers, rows) {
    const t = el('table', { class: 'table' });
    t.append(el('thead', null, el('tr', null, headers.map((h) => el('th', { scope: 'col', text: h })))));
    const tb = el('tbody');
    for (const r of rows) tb.append(el('tr', null, r.map((c, i) => (i === 0 ? el('th', { scope: 'row', text: c }) : el('td', { text: c })))));
    t.append(tb);
    return el('div', { class: 'table-wrap' }, t);
  }
  function updateExportLink() {
    const q = new URLSearchParams();
    const f = app.filters;
    const from = f.from || (app.data.metrics && app.data.metrics.from) || '';
    const to = f.to || (app.data.metrics && app.data.metrics.to) || '';
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (f.branch) q.set('branch', f.branch);
    if (f.driverId) q.set('driverId', f.driverId);
    const s = q.toString();
    $('#link-export').href = `/api/export.csv${s ? `?${s}` : ''}`;
  }

  $('#form-metrics').addEventListener('submit', async (e) => {
    e.preventDefault();
    const from = $('#m-from').value;
    const to = $('#m-to').value;
    if (from && to && from > to) { notify('La fecha "desde" no puede ser posterior a "hasta".', 'error'); return; }
    app.filters.from = from;
    app.filters.to = to;
    app.filters.branch = $('#m-branch').value;
    app.filters.driverId = $('#m-driver').value;
    delete e.currentTarget.dataset.dirty;
    if (await refresh({ force: true })) notify('Filtros aplicados.');
  });
  $('#btn-metrics-reset').addEventListener('click', async () => {
    Object.assign(app.filters, { from: '', to: '', branch: '', driverId: '' });
    $('#m-branch').value = '';
    $('#m-driver').value = '';
    delete $('#form-metrics').dataset.dirty;
    await refresh({ force: true });
  });

  // ---------- Costos ----------
  const COST_FIELDS = ['labor', 'fuel', 'maintenance', 'insurance', 'other'];
  function renderCosts() {
    const c = app.data.costs;
    const form = $('#form-costs');
    const box = clear($('#costs-view'));
    if (!c) { box.append(el('p', { class: 'muted', text: 'Sin datos de costos.' })); return; }
    if (app.costsFilledFor !== c.month || !form.dataset.dirty) {
      $('#c-month').value = c.month || '';
      for (const k of COST_FIELDS) $(`#c-${k}`).value = c[k] ?? 0;
      app.costsFilledFor = c.month;
      delete form.dataset.dirty;
    }
    const diff = Number(c.feesMinusCost);
    box.append(el('div', { class: 'tiles' },
      counterLike('Costo total del mes', money(c.totalCost)),
      counterLike('Entregas del mes', intFmt.format(Number(c.deliveredInMonth) || 0)),
      counterLike('Costo promedio por entrega', c.costPerDelivery === null || c.costPerDelivery === undefined ? '—' : money(Math.round(c.costPerDelivery))),
      counterLike('Tarifas cobradas', money(c.feesInMonth)),
      counterLike('Tarifas menos costos', money(c.feesMinusCost), Number.isFinite(diff) && diff < 0 ? 'neg' : 'pos')));
    box.append(el('p', { class: 'note' },
      'El costo por entrega es un costo promedio asignado (costos del mes divididos por las entregas del mes, todas las sucursales); no es el costo exacto de cada viaje.'));
  }
  function counterLike(title, value, mod) {
    return el('div', { class: `tile${mod ? ` tile-${mod}` : ''}` },
      el('p', { class: 'tile-title', text: title }),
      el('p', { class: 'tile-value', text: value }));
  }
  $('#c-month').addEventListener('change', async (e) => {
    const v = e.target.value;
    if (!/^\d{4}-\d{2}$/.test(v)) return;
    app.filters.costMonth = v;
    delete $('#form-costs').dataset.dirty;
    app.costsFilledFor = null;
    e.target.blur();
    await refresh({ force: true });
  });
  $('#form-costs').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const errBox = $('#costs-error');
    errBox.textContent = '';
    if (!form.reportValidity()) return;
    const body = { month: $('#c-month').value };
    for (const k of COST_FIELDS) {
      const n = Number($(`#c-${k}`).value || 0);
      if (!Number.isInteger(n) || n < 0) { errBox.textContent = 'Los montos deben ser enteros mayores o iguales a 0.'; return; }
      body[k] = n;
    }
    try {
      await api('/api/settings', { method: 'POST', body });
      app.filters.costMonth = body.month;
      delete form.dataset.dirty;
      app.costsFilledFor = null;
      notify(`Costos de ${body.month} guardados.`, 'success');
      await refresh({ force: true });
    } catch (err) {
      if (err.status !== 401) errBox.textContent = err.message;
    }
  });

  // ---------- Usuarios ----------
  function renderUsers() {
    const box = clear($('#users-view'));
    const users = app.data.users || [];
    box.append(el('h2', { text: 'Usuarios' }));
    if (!users.length) { box.append(el('p', { class: 'muted', text: 'Sin usuarios.' })); return; }
    const list = el('ul', { class: 'user-list' });
    const me = app.data.user.id;
    for (const u of users) {
      const active = u.active !== false;
      list.append(el('li', { class: `card user-row${active ? '' : ' inactive'}` },
        el('div', { class: 'user-info' },
          el('strong', { text: u.name }),
          el('span', { class: 'muted', text: ` @${u.username} · ${ROLE_LABEL[u.role] || u.role}` }),
          active ? null : el('span', { class: 'badge badge-canceled', text: 'Inactivo' })),
        el('div', { class: 'actions' },
          u.id === me ? null : actionBtn(active ? 'Desactivar' : 'Activar', () => flowToggleUser(u), active ? 'btn-danger-soft' : ''),
          actionBtn('Cambiar contraseña', () => flowPassword(u)))));
    }
    box.append(list);
  }

  async function flowToggleUser(u) {
    const activate = u.active === false;
    const ok = await ask({
      title: activate ? 'Activar usuario' : 'Desactivar usuario',
      lines: [activate ? `¿Activar a ${u.name} (@${u.username})?` : `¿Desactivar a ${u.name} (@${u.username})? Se cerrarán sus sesiones.`],
      confirmText: activate ? 'Activar' : 'Desactivar',
      danger: !activate,
    });
    if (!ok) return;
    try {
      await api('/api/users/update', { method: 'POST', body: { id: u.id, active: activate } });
      notify(activate ? 'Usuario activado.' : 'Usuario desactivado.', 'success');
      await refresh({ force: true });
    } catch (err) { if (err.status !== 401) notify(err.message, 'error'); }
  }
  async function flowPassword(u) {
    const vals = await ask({
      title: 'Cambiar contraseña',
      lines: [`Usuario: ${u.name} (@${u.username})`],
      fields: [{ name: 'password', type: 'password', label: 'Nueva contraseña', required: true, minlength: 6, help: 'Mínimo 6 caracteres.', autocomplete: 'new-password' }],
      confirmText: 'Guardar',
    });
    if (!vals) return;
    try {
      await api('/api/users/update', { method: 'POST', body: { id: u.id, password: vals.password } });
      notify('Contraseña actualizada.', 'success');
    } catch (err) { if (err.status !== 401) notify(err.message, 'error'); }
  }

  $('#form-user').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const errBox = $('#user-error');
    errBox.textContent = '';
    if (!form.reportValidity()) return;
    const body = {
      name: $('#u-name').value.trim(),
      username: $('#u-username').value.trim(),
      password: $('#u-password').value,
      role: $('#u-role').value,
    };
    try {
      const res = await api('/api/users', { method: 'POST', body });
      form.reset();
      delete form.dataset.dirty;
      notify(`Usuario ${res && res.user ? res.user.username : body.username} creado.`, 'success');
      await refresh({ force: true });
    } catch (err) { if (err.status !== 401) errBox.textContent = err.message; }
  });

  // ---------- Nuevo pedido ----------
  function addItemRow(name = '', qty = 1) {
    const rows = $('#items-rows');
    const idx = rows.children.length + 1;
    const nameId = `item-name-${Date.now()}-${idx}`;
    const qtyId = `item-qty-${Date.now()}-${idx}`;
    const row = el('div', { class: 'item-row' },
      el('div', { class: 'field grow' },
        el('label', { for: nameId, class: 'small', text: `Producto ${idx}` }),
        el('input', { id: nameId, class: 'item-name', value: name, autocomplete: 'off' })),
      el('div', { class: 'field qty' },
        el('label', { for: qtyId, class: 'small', text: 'Cant.' }),
        el('input', { id: qtyId, class: 'item-qty', type: 'number', min: '1', step: '1', inputmode: 'numeric', value: String(qty) })),
      el('button', {
        type: 'button', class: 'btn btn-small btn-ghost item-remove', 'aria-label': `Quitar producto ${idx}`, text: 'Quitar',
        on: { click: () => { row.remove(); if (!rows.children.length) addItemRow(); } },
      }));
    rows.append(row);
    return row;
  }
  $('#btn-add-item').addEventListener('click', () => { const r = addItemRow(); r.querySelector('input').focus(); });
  addItemRow();

  function intOrNull(v) {
    const s = String(v ?? '').trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n) : NaN;
  }

  $('#form-order').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const errBox = $('#order-error');
    errBox.textContent = '';
    const address = $('#order-address').value.trim();
    if (!address) {
      errBox.textContent = 'La dirección es obligatoria.';
      $('#order-address').focus();
      return;
    }
    const deliveryFee = intOrNull($('#order-fee').value);
    const total = intOrNull($('#order-total').value);
    if (Number.isNaN(deliveryFee) || Number.isNaN(total) || (deliveryFee !== null && deliveryFee < 0) || (total !== null && total < 0)) {
      errBox.textContent = 'Tarifa y total deben ser montos enteros en pesos, sin puntos.';
      return;
    }
    const items = $$('#items-rows .item-row').map((r) => ({
      name: r.querySelector('.item-name').value.trim(),
      qty: Math.max(1, parseInt(r.querySelector('.item-qty').value, 10) || 1),
    })).filter((i) => i.name);
    const body = {
      channel: $('#order-channel').value,
      branch: $('#order-branch').value.trim(),
      customerName: $('#order-customer').value.trim(),
      customerPhone: $('#order-phone').value.trim(),
      address,
      addressDetail: $('#order-detail').value.trim(),
      notes: $('#order-notes').value.trim(),
      deliveryFee,
      total,
      promisedAt: promisedFromTime($('#order-promised').value),
      items,
    };
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await api('/api/orders', { method: 'POST', body });
      const branch = body.branch;
      form.reset();
      $('#order-branch').value = branch || 'Melipilla';
      clear($('#items-rows'));
      addItemRow();
      delete form.dataset.dirty;
      notify(`Pedido ${res && res.order ? res.order.id : ''} creado.`, 'success');
      selectTab('orders', false);
      await refresh({ force: true });
    } catch (err) {
      if (err.status !== 401) errBox.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Motorista ----------
  function driverCard(o) {
    const selected = o.status === 'ready' && app.batch.has(o.id);
    const card = el('article', { class: `card order-card driver-card status-${o.status}${selected ? ' is-selected' : ''}`, dataset: { id: o.id } });
    if (o.status === 'ready') {
      const cbId = `batch-${o.id}`;
      const cb = el('input', {
        type: 'checkbox', id: cbId, class: 'batch-check', checked: selected,
        on: {
          change: () => {
            if (cb.checked && !app.batch.has(o.id) && app.batch.size >= BATCH_MAX) {
              cb.checked = false;
              notify(`Una salida admite como máximo ${BATCH_MAX} pedidos.`, 'error');
              return;
            }
            if (cb.checked) app.batch.add(o.id); else app.batch.delete(o.id);
            card.classList.toggle('is-selected', cb.checked);
            updateBatchBar();
          },
        },
      });
      card.append(el('label', { class: 'batch-select', for: cbId }, cb, el('span', { text: `Llevar ${o.id} en esta salida` })));
    }
    card.append(cardHeader(o));
    card.append(el('p', { class: 'order-time', text: timeLine(o) }));
    card.append(orderSummary(o));
    const big = el('div', { class: 'actions actions-big' });
    if (o.status === 'ready') big.append(actionBtn('Salí', () => flowDepart(o), 'btn-primary btn-xl'));
    if (o.status === 'in_transit') big.append(actionBtn('Entregado', () => flowDeliver(o), 'btn-success btn-xl'));
    if (o.status === 'preparing') big.append(el('p', { class: 'muted', text: 'Aún en preparación. Espera a que el local lo marque listo.' }));
    card.append(big);
    const small = el('div', { class: 'actions' });
    small.append(el('a', { class: 'btn', href: mapUrl(o), target: '_blank', rel: 'noopener', text: 'Abrir en mapa' }));
    if (o.customerPhone) small.append(el('a', { class: 'btn', href: `tel:${String(o.customerPhone).replace(/[^\d+]/g, '')}`, text: 'Llamar' }));
    if (o.status === 'ready' || o.status === 'in_transit') small.append(actionBtn('Incidencia', () => flowIncident(o)));
    if (o.status === 'in_transit') small.append(actionBtn('No entregado', () => flowFail(o), 'btn-danger-soft'));
    card.append(small);
    return card;
  }

  function mapUrl(o) {
    let query;
    if (Number.isFinite(Number(o.lat)) && Number.isFinite(Number(o.lng)) && o.lat !== null && o.lng !== null) {
      query = `${o.lat},${o.lng}`;
    } else {
      const parts = [o.address];
      if (o.branch && !/^\d+$/.test(String(o.branch))) parts.push(o.branch);
      parts.push('Chile');
      query = parts.filter(Boolean).join(', ');
    }
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }

  function driverGroup(key, title, list, extra) {
    const titleId = `drv-${key}-title`;
    const sec = el('section', { class: `driver-group group-${key}`, 'aria-labelledby': titleId },
      el('h3', { id: titleId, class: 'group-title' }, title, el('span', { class: 'count', text: ` (${list.length})` })));
    if (extra && extra.before) sec.append(extra.before);
    const cards = el('div', { class: 'driver-cards' });
    for (const o of list) cards.append(driverCard(o));
    sec.append(cards);
    if (extra && extra.after) sec.append(extra.after);
    return sec;
  }

  function selectedReady() {
    return (app.data.orders || []).filter((o) => app.batch.has(o.id) && o.status === 'ready' && !o.pickup);
  }
  function updateBatchBar() {
    const bar = $('#batch-bar');
    if (!bar) return;
    const n = selectedReady().length;
    show(bar, n > 0);
    $('#btn-batch').textContent = `Salí con ${plural(n, 'pedido', 'pedidos')}`;
  }
  function batchBar() {
    return el('div', { id: 'batch-bar', class: 'batch-bar', hidden: true },
      el('button', { type: 'button', id: 'btn-batch', class: 'btn btn-primary btn-xl', text: 'Salí con 0 pedidos', on: { click: () => flowDepartBatch() } }),
      el('button', {
        type: 'button', class: 'btn btn-small btn-ghost', text: 'Quitar selección',
        on: { click: () => { app.batch.clear(); renderDriver(); } },
      }));
  }

  function renderDriver() {
    const orders = app.data.orders || [];
    const active = orders.filter((o) => ACTIVE_STATUSES.includes(o.status) && !o.pickup);
    const of = (s) => active.filter((o) => o.status === s).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const transit = of('in_transit');
    const ready = of('ready');
    const preparing = of('preparing');
    // La selección solo conserva pedidos que siguen listos y asignados a este motorista.
    const readyIds = new Set(ready.map((o) => o.id));
    for (const id of [...app.batch]) if (!readyIds.has(id)) app.batch.delete(id);

    const box = clear($('#driver-active'));
    if (!active.length) box.append(el('p', { class: 'card muted empty', text: 'No tienes pedidos asignados por ahora.' }));
    if (transit.length) box.append(driverGroup('in_transit', 'En ruta', transit));
    if (ready.length) {
      box.append(driverGroup('ready', 'Listos para retirar', ready, {
        before: ready.length > 1
          ? el('p', { class: 'muted small', text: 'Marca los pedidos que llevas y toca "Salí con N pedidos", o usa "Salí" en cada uno.' })
          : null,
        after: batchBar(),
      }));
      updateBatchBar();
    }
    if (preparing.length) box.append(driverGroup('preparing', 'En preparación', preparing));

    const today = chileDate(serverNow());
    const done = orders.filter((o) => o.status === 'delivered' && o.deliveredAt && chileDate(o.deliveredAt) === today)
      .sort((a, b) => String(b.deliveredAt).localeCompare(String(a.deliveredAt)));
    const doneBox = clear($('#driver-done'));
    if (!done.length) doneBox.append(el('p', { class: 'muted', text: 'Aún no hay entregas hoy.' }));
    else {
      doneBox.append(el('p', { class: 'muted', text: plural(done.length, 'entrega', 'entregas') + ' hoy.' }));
      const ul = el('ul', { class: 'done-list' });
      for (const o of done) {
        ul.append(el('li', null, el('strong', { text: `${hhmm(o.deliveredAt)} ` }), `${o.id} · ${o.address || ''}`,
          o.deliveryCheck === 'far' ? el('span', { class: 'warn-text', text: ` · lejos de la dirección (${meters(o.deliveryDistanceM)})` }) : null));
      }
      doneBox.append(ul);
    }
  }

  // ---------- Diálogo ----------
  let dlgResolve = null;
  const dlg = $('#dlg');

  function closeDialog(result = null) {
    if (dlg.open) {
      if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
    }
    if (dlgResolve) { const r = dlgResolve; dlgResolve = null; r(result); }
  }

  /**
   * Muestra un diálogo modal. Devuelve un objeto con los valores (o {} si no hay campos)
   * al confirmar, o null si se cancela.
   */
  function ask({ title, order = null, lines = [], items = [], fields = [], confirmText = 'Confirmar', cancelText = 'Cancelar', altText = null, danger = false, info = null }) {
    if (dlgResolve) closeDialog(null);
    $('#dlg-title').textContent = title;
    const body = clear($('#dlg-body'));
    $('#dlg-error').textContent = '';
    if (order) {
      body.append(el('div', { class: 'dlg-order' }, cardHeader(order), el('p', { class: 'order-time', text: timeLine(order) }), orderSummary(order, { compact: true }),
        order.driverName ? el('p', { class: 'small', text: `Motorista: ${order.driverName}` }) : null));
    }
    for (const l of lines) body.append(el('p', { text: l }));
    if (items.length) body.append(el('ul', { class: 'dlg-list' }, items.map((t) => el('li', { text: t }))));
    const alt = $('#dlg-alt');
    alt.textContent = altText || '';
    show(alt, !!altText);
    if (info) body.append(el('p', { class: 'dlg-info', text: info }));
    const inputs = [];
    fields.forEach((f, i) => {
      const id = `dlg-field-${i}`;
      const wrap = el('div', { class: 'field' }, el('label', { for: id, text: f.label }));
      let input;
      if (f.type === 'textarea') {
        input = el('textarea', { id, name: f.name, rows: '3', required: !!f.required });
      } else if (f.type === 'select') {
        input = el('select', { id, name: f.name, required: !!f.required });
        for (const [v, label] of f.options) input.append(el('option', { value: String(v), text: label }));
        if (f.value !== undefined && f.value !== null) input.value = String(f.value);
      } else {
        input = el('input', { id, name: f.name, type: f.type || 'text', required: !!f.required, autocomplete: f.autocomplete || 'off' });
        if (f.minlength) input.minLength = f.minlength;
      }
      if (f.help) {
        const hid = `${id}-help`;
        input.setAttribute('aria-describedby', hid);
        wrap.append(input, el('small', { id: hid, class: 'help', text: f.help }));
      } else wrap.append(input);
      body.append(wrap);
      inputs.push([f, input]);
    });
    const ok = $('#dlg-ok');
    ok.textContent = confirmText || '';
    show(ok, !!confirmText);
    ok.classList.toggle('btn-danger', !!danger);
    ok.classList.toggle('btn-primary', !danger);
    $('#dlg-cancel').textContent = confirmText ? cancelText : 'Cerrar';
    dlg._inputs = inputs;

    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    const firstInput = inputs.length ? inputs[0][1] : null;
    (firstInput || (confirmText ? ok : $('#dlg-cancel'))).focus();
    return new Promise((resolve) => { dlgResolve = resolve; });
  }

  $('#dlg-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inputs = dlg._inputs || [];
    const vals = {};
    for (const [f, input] of inputs) {
      const v = f.type === 'password' ? input.value : String(input.value).trim();
      if (f.required && !v) {
        $('#dlg-error').textContent = `${f.label}: campo obligatorio.`;
        input.focus();
        return;
      }
      if (f.minlength && v.length < f.minlength) {
        $('#dlg-error').textContent = `${f.label}: mínimo ${f.minlength} caracteres.`;
        input.focus();
        return;
      }
      vals[f.name] = v;
    }
    closeDialog(vals);
  });
  $('#dlg-cancel').addEventListener('click', () => closeDialog(null));
  $('#dlg-alt').addEventListener('click', () => closeDialog({ alt: true }));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(null); });
  dlg.addEventListener('close', () => { if (dlgResolve && !dlg.open) closeDialog(null); });

  // ---------- Acciones de pedido ----------
  async function runAction(o, action, extra = {}, successMsg) {
    try {
      const res = await api('/api/action', { method: 'POST', body: { orderId: o.id, action, ...extra } });
      notify(successMsg || `Pedido ${o.id} actualizado.`, 'success');
      await refresh({ force: true });
      return res;
    } catch (err) {
      if (err.status !== 401) notify(err.message, 'error');
      if (err.status === 409 || err.status === 404) refresh({ force: true });
      return null;
    }
  }

  async function flowReady(o) {
    if (!(await ask({ title: 'Marcar listo', order: o, confirmText: 'Marcar listo' }))) return;
    await runAction(o, 'ready', {}, `Pedido ${o.id} listo para salir.`);
  }
  async function flowAssign(o) {
    const drivers = (app.data.drivers || []).filter((d) => d.active !== false);
    if (!drivers.length) { notify('No hay motoristas activos. Créalos en Usuarios.', 'error'); return; }
    const vals = await ask({
      title: o.driverId ? 'Reasignar motorista' : 'Asignar motorista',
      order: o,
      fields: [{ name: 'driverId', type: 'select', label: 'Motorista', required: true, value: o.driverId ?? drivers[0].id, options: drivers.map((d) => [d.id, d.name]) }],
      confirmText: 'Asignar',
    });
    if (!vals) return;
    const driver = drivers.find((d) => String(d.id) === vals.driverId);
    await runAction(o, 'assign', { driverId: Number(vals.driverId) }, `Pedido ${o.id} asignado a ${driver ? driver.name : 'motorista'}.`);
  }
  async function flowDepart(o) {
    const mine = isDriver();
    if (!(await ask({ title: 'Confirmar salida', order: o, lines: [mine ? '¿Sales ahora con este pedido?' : `¿Registrar la salida con ${o.driverName || 'el motorista'}?`], confirmText: mine ? 'Sí, salí' : 'Registrar salida' }))) return;
    await runAction(o, 'depart', {}, `Salida registrada (${o.id}).`);
  }
  async function flowDeliver(o) {
    if (!(await ask({
      title: 'Confirmar entrega', order: o,
      lines: ['¿El pedido fue entregado al cliente?'],
      info: 'Se intentará registrar la ubicación actual (opcional). Si no está disponible, la entrega se registra igual.',
      confirmText: 'Sí, entregado',
    }))) return;
    notify('Obteniendo ubicación…');
    const pos = await getPosition();
    const extra = pos.coords ? { lat: pos.coords.lat, lng: pos.coords.lng, accuracy: pos.coords.accuracy } : {};
    const msg = pos.coords ? `Entrega registrada con ubicación (${o.id}).` : `Entrega registrada sin ubicación (${o.id}): ${pos.error}`;
    const res = await runAction(o, 'deliver', extra, msg);
    const d = res && res.order;
    // Aviso no bloqueante: la entrega ya quedó registrada.
    if (d && d.deliveryCheck === 'far') {
      const dist = Number(d.deliveryDistanceM);
      const txt = Number.isFinite(dist) && dist > warnMeters()
        ? `Estás a ${meters(dist)} de la dirección; la entrega quedó registrada con esta observación.`
        : `La ubicación del teléfono es imprecisa (±${meters(d.deliveryAccuracy)}); la entrega quedó registrada con esta observación.`;
      notify(txt, 'warn', 15000);
    }
  }

  // Salida con varios pedidos (todo o nada en el servidor).
  async function flowDepartBatch() {
    const sel = selectedReady();
    if (!sel.length) { notify('Selecciona al menos un pedido listo.', 'error'); return; }
    if (sel.length > BATCH_MAX) { notify(`Una salida admite como máximo ${BATCH_MAX} pedidos.`, 'error'); return; }
    const n = sel.length;
    const ok = await ask({
      title: `Salir con ${plural(n, 'pedido', 'pedidos')}`,
      lines: [n === 1 ? '¿Sales ahora con este pedido?' : `¿Sales ahora con estos ${n} pedidos? Todos quedan en ruta con la misma hora de salida.`],
      items: sel.map((o) => [o.id, o.address || 'Sin dirección', o.addressDetail].filter(Boolean).join(' · ')),
      info: 'La entrega se marca después, pedido por pedido.',
      confirmText: n === 1 ? 'Sí, salí' : `Sí, salí con ${n}`,
    });
    if (!ok) return;
    try {
      await api('/api/action', { method: 'POST', body: { action: 'depart_batch', orderIds: sel.map((o) => o.id) } });
      app.batch.clear();
      notify(`Salida registrada con ${plural(n, 'pedido', 'pedidos')}.`, 'success');
      await refresh({ force: true });
    } catch (err) {
      if (err.status !== 401) notify(`No se registró ninguna salida. ${err.message}`, 'error');
      if (err.data && err.data.orderId && err.status === 404) app.batch.delete(String(err.data.orderId).toUpperCase());
      if (err.status === 409 || err.status === 404) refresh({ force: true });
    }
  }

  // Escaneo de un pedido listo (motorista): salir solo con él o sumarlo a la salida.
  async function flowScanReady(o) {
    const inSel = app.batch.has(o.id);
    const others = selectedReady().filter((x) => x.id !== o.id).length;
    const lines = [];
    if (others) lines.push(`Tienes ${plural(others, 'otro pedido seleccionado', 'otros pedidos seleccionados')} para la salida.`);
    let altText = 'Agregar a la salida';
    if (inSel) altText = others ? `Salí con ${others + 1} pedidos` : null;
    const res = await ask({
      title: 'Pedido listo para retirar', order: o, lines,
      info: inSel ? 'Este pedido ya está en la selección de la salida.' : null,
      confirmText: 'Salir solo con este', altText,
    });
    if (!res) return;
    if (res.alt) {
      if (inSel) { await flowDepartBatch(); return; }
      if (app.batch.size >= BATCH_MAX) { notify(`Una salida admite como máximo ${BATCH_MAX} pedidos.`, 'error'); return; }
      app.batch.add(o.id);
      renderDriver();
      notify(`${o.id} agregado a la salida (${plural(selectedReady().length, 'pedido seleccionado', 'pedidos seleccionados')}).`, 'success');
      return;
    }
    await runAction(o, 'depart', {}, `Salida registrada (${o.id}).`);
  }
  async function flowIncident(o) {
    const vals = await ask({
      title: 'Registrar incidencia', order: o,
      fields: [{ name: 'note', type: 'textarea', label: 'Describe la incidencia', required: true }],
      confirmText: 'Registrar incidencia',
    });
    if (!vals) return;
    await runAction(o, 'incident', { note: vals.note }, `Incidencia registrada (${o.id}).`);
  }
  async function flowFail(o) {
    const vals = await ask({
      title: 'No entregado', order: o,
      lines: ['El pedido quedará como no entregado.'],
      fields: [{ name: 'note', type: 'textarea', label: 'Motivo', required: true }],
      confirmText: 'Marcar no entregado', danger: true,
    });
    if (!vals) return;
    await runAction(o, 'fail', { note: vals.note }, `Pedido ${o.id} marcado como no entregado.`);
  }
  async function flowCancel(o) {
    const vals = await ask({
      title: 'Cancelar pedido', order: o,
      fields: [{ name: 'note', type: 'textarea', label: 'Motivo (opcional)' }],
      confirmText: 'Cancelar pedido', cancelText: 'Volver', danger: true,
    });
    if (!vals) return;
    await runAction(o, 'cancel', vals.note ? { note: vals.note } : {}, `Pedido ${o.id} cancelado.`);
  }

  function getPosition() {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) { resolve({ error: 'este dispositivo no entrega ubicación.' }); return; }
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      const guard = setTimeout(() => finish({ error: 'la ubicación tardó demasiado.' }), GEO_TIMEOUT_MS + 1500);
      try {
        navigator.geolocation.getCurrentPosition(
          (p) => { clearTimeout(guard); finish({ coords: { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) } }); },
          (err) => {
            clearTimeout(guard);
            const reason = err && err.code === 1 ? 'permiso de ubicación denegado.'
              : err && err.code === 3 ? 'la ubicación tardó demasiado.' : 'ubicación no disponible.';
            finish({ error: reason });
          },
          { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 30000 },
        );
      } catch {
        clearTimeout(guard);
        finish({ error: 'ubicación no disponible.' });
      }
    });
  }

  // ---------- Lector / escaneo ----------
  function extractId(text) {
    let s = String(text || '').trim();
    if (!s) return '';
    const m = s.match(/DESPACHO:\s*(\S+)/i);
    if (m) s = m[1];
    return s.trim();
  }

  async function handleCode(text) {
    if (!app.data) { notify('Ingresa primero para buscar pedidos.', 'error'); return; }
    const id = extractId(text);
    if (!id) { notify('Código vacío.', 'error'); return; }
    const find = () => (app.data.orders || []).find((o) => String(o.id).toLowerCase() === id.toLowerCase());
    let o = find();
    if (!o) {
      await refresh({ force: true });
      if (!app.data) return;
      o = find();
    }
    if (!o) {
      await ask({ title: 'Pedido no encontrado', lines: [isDriver() ? 'Pedido no encontrado o no asignado a ti.' : `Pedido no encontrado: ${id}.`], confirmText: null });
      return;
    }
    const next = nextAction(o);
    if (next.flow) { await next.flow(o); return; }
    const res = await ask({ title: `Pedido ${o.id}`, order: o, info: next.info, confirmText: next.altLabel || null });
    if (res && next.alt) await next.alt(o);
  }

  function nextAction(o) {
    if (o.pickup) return { info: 'Pedido de retiro en local: no se despacha.' };
    const s = o.status;
    if (CLOSED_STATUSES.includes(s)) return { info: `Este pedido ya está cerrado (${STATUS_LABEL[s]}).` };
    if (isDriver()) {
      const mine = app.data.user && o.driverId === app.data.user.id;
      if (!mine) return { info: 'Pedido no encontrado o no asignado a ti.' };
      if (s === 'ready') return { flow: flowScanReady };
      if (s === 'in_transit') return { flow: flowDeliver };
      return { info: 'Aún en preparación. Espera a que el local lo marque listo.' };
    }
    if (s === 'preparing') return { flow: flowReady };
    if (s === 'ready' && !o.driverId) return { info: 'Debe asignarse un motorista antes de la salida.', alt: flowAssign, altLabel: 'Asignar motorista' };
    if (s === 'ready') return { flow: flowDepart };
    if (s === 'in_transit') {
      if (isAdmin()) return { flow: flowDeliver };
      return { info: `En ruta con ${o.driverName || 'el motorista'}. La entrega la registra el motorista.` };
    }
    return { info: STATUS_LABEL[s] || s };
  }

  for (const id of ['#form-scan-admin', '#form-scan-driver']) {
    $(id).addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = e.currentTarget.querySelector('input');
      const text = input.value;
      input.value = '';
      dirtyFields.delete(input);
      await handleCode(text);
    });
  }

  window.addEventListener('android-scan', (e) => {
    const text = e && e.detail ? e.detail.text : '';
    if (!text) return;
    handleCode(text);
  });

  function androidScan() {
    try { window.AndroidApp.scan(); } catch { notify('No se pudo abrir el escáner.', 'error'); }
  }
  for (const b of $$('[data-android-scan]')) b.addEventListener('click', androidScan);
  $('#btn-server').addEventListener('click', () => {
    try { window.AndroidApp.openSettings(); } catch { notify('No se pudo abrir la configuración.', 'error'); }
  });

  // ---------- Encabezado ----------
  $('#btn-refresh').addEventListener('click', async () => { if (await refresh({ force: true })) notify('Actualizado.'); });
  $('#btn-logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', authRedirect: false }); } catch (err) {
      if (err.code === 'offline') { notify(err.message, 'error'); return; }
    }
    app.data = null;
    stopTimer();
    $('#login-password').value = '';
    showLogin();
  });
  $('#btn-retry').addEventListener('click', () => boot());

  // ---------- Setup / login ----------
  $('#form-setup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const errBox = $('#setup-error');
    errBox.textContent = '';
    if (!form.reportValidity()) return;
    const body = {
      name: $('#setup-name').value.trim(),
      username: $('#setup-username').value.trim(),
      password: $('#setup-password').value,
    };
    if (!$('#setup-token-field').hidden) body.setupToken = $('#setup-token').value.trim();
    try {
      await api('/api/setup', { method: 'POST', body, authRedirect: false });
      form.reset();
      notify('Administrador creado.', 'success');
      await refresh({ force: true });
    } catch (err) { errBox.textContent = err.message; }
  });

  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const errBox = $('#login-error');
    errBox.textContent = '';
    if (!form.reportValidity()) return;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/api/login', {
        method: 'POST', authRedirect: false,
        body: { username: $('#login-username').value.trim(), password: $('#login-password').value },
      });
      $('#login-password').value = '';
      await refresh({ force: true });
    } catch (err) {
      errBox.textContent = err.status === 401 ? (err.message || 'Usuario o contraseña incorrectos.') : err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Inicio ----------
  async function boot() {
    showView('loading');
    $('#loading-text').textContent = 'Cargando…';
    show($('#btn-retry'), false);
    let status;
    try {
      status = await api('/api/status', { authRedirect: false });
    } catch (err) {
      $('#loading-text').textContent = err.code === 'offline' ? 'No se pudo conectar con el servidor.' : err.message;
      show($('#btn-retry'), true);
      updateAndroidButtons(false);
      return;
    }
    if (status && status.needsSetup) { showSetup(status.setupTokenRequired); return; }
    const ok = await refresh({ force: true });
    if (!ok && !app.data && !$('#view-loading').hidden) {
      $('#loading-text').textContent = 'No se pudo cargar el panel.';
      show($('#btn-retry'), true);
    }
  }

  boot();
})();
