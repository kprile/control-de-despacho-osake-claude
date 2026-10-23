# Contrato interno del piloto de despachos (Osake, Melipilla)

Documento fuente de verdad entre backend, web y Android. Si algo cambia, se cambia aquí primero.

## Alcance

- Backend Node.js (>= 22.13, ESM, sin Express) con `node:sqlite`. Base en `data/despachos.sqlite` (ignorada por git).
- Pantallas web servidas por el mismo servidor desde `public/`.
- Cliente Android (Java, WebView) que carga el servidor configurado. Solo Android.
- Contraseña: **mínimo 6 caracteres** (no longitud exacta).
- Zona horaria de negocio: `America/Santiago`. Timestamps guardados como ISO‑8601 UTC (`2026-10-22T23:10:00.000Z`) generados por el servidor.

## Configuración (variables de entorno, ver `.env.example`)

| Variable | Defecto | Uso |
|---|---|---|
| `HOST` | `127.0.0.1` | Interfaz de escucha. En producción detrás de proxy HTTPS. |
| `PORT` | `4317` | Puerto. |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:4317` | Origen canónico. Se usa para validar `Origin` en mutaciones. Si empieza con `https://` la cookie lleva `Secure`. Se admiten varios separados por coma. |
| `SETUP_TOKEN` | vacío | Si está definido, `POST /api/setup` exige `setupToken` igual. Evita que el alta inicial quede expuesta. |
| `MERCAT_WEBHOOK_SECRET` | vacío | Sin él, el webhook responde 503 `not_configured`. |
| `DB_PATH` | `data/despachos.sqlite` | Ruta de la base (los tests usan una temporal). |
| `SESSION_DAYS` | `14` | Duración de sesión. |
| `GOOGLE_SHEETS_ID` | vacío | ID de la hoja de Google para la copia de solo lectura. Ver "Copia a Google Sheets". |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | vacío | Ruta al JSON de la clave de la cuenta de servicio (fuera del repo). |
| `GOOGLE_SHEETS_INTERVAL_SECONDS` | `60` | Segundos mínimos entre copias. |
| `GOOGLE_SHEETS_DAYS` | `90` | Días de pedidos copiados. |
| `GOOGLE_API_BASE`, `GOOGLE_TOKEN_URL` | Google | Solo para pruebas (servidor falso). |
| `DELIVERY_WARN_METERS` | `300` | Umbral (m) de la verificación de ubicación al entregar. Valor inválido o <= 0 => 300. |

El servidor carga `.env` si existe (parser propio mínimo `CLAVE=valor`).

## Roles

- `admin`: todo. Crea usuarios, configura costos, ve métricas.
- `local`: crea pedidos manuales, marca listo, asigna, cancela, imprime QR, ve todos los pedidos.
- `driver` (motorista): solo ve pedidos **asignados a él**; registra salida, entrega e incidencia de sus pedidos.

## Estados y transiciones

Estados locales: `preparing`, `ready`, `in_transit`, `delivered`, `canceled`, `failed`.

| Acción (`action`) | Quién | Desde | Hacia / efecto |
|---|---|---|---|
| `ready` | admin, local | `preparing` | `ready`, fija `ready_at` |
| `assign` (`driverId`) | admin, local | `preparing`, `ready` | fija `driver_id` (reasignable mientras no haya salido) |
| `depart` | driver asignado, admin, local | `ready` con motorista | `in_transit`, fija `departed_at` (`trip_id` queda null) |
| `depart_batch` (`orderIds`, 1–20) | driver (solo sus pedidos), admin, local | todos `ready` con el **mismo** motorista | todos `in_transit` con la misma `departed_at` y un `trip_id` común |
| `deliver` (`lat`,`lng`,`accuracy` opcionales) | driver asignado, admin | `in_transit` | `delivered`, fija `delivered_at`, ubicación y verificación de ubicación (ver abajo) |
| `incident` (`note` obligatorio) | driver asignado, admin, local | `ready`, `in_transit` | agrega nota de incidencia, no cambia estado |
| `fail` (`note` obligatorio) | driver asignado, admin | `in_transit` | `failed` |
| `cancel` (`note` opcional) | admin, local | `preparing`, `ready` | `canceled` |

Errores de transición: HTTP 409 `{ "error": "invalid_transition", "message": "..." }`. Repetir entrega => 409.
Cada acción queda en tabla `order_events` (historial; nunca se borra).

### Salida en lote (`depart_batch`)

- Request: `POST /api/action` con `{ "action": "depart_batch", "orderIds": ["P-1001", "DESPACHO:P-1002", ...] }`. Respuesta 200: `{ "tripId": "V-...", "orders": [Order] }` en el mismo orden pedido.
- `orderIds` no es lista, está vacía, trae más de 20 o repite un id => 400 `bad_request`.
- **Todo o nada** (una transacción): si un pedido no es válido no cambia ninguno. Error con el campo extra `orderId` del pedido que falló y su id en `message`:
  - inexistente, o (motorista) asignado a otro => 404 `not_found` (igual que hoy: los ajenos "no existen");
  - no está `ready`, es retiro, no tiene motorista o tiene otro motorista que el resto => 409 `invalid_transition`.
- Todos reciben la misma `departed_at` y el mismo `trip_id` (`V-<base36 tiempo>-<6 hex>`). Se registra un evento `depart` por pedido en `order_events` con esa misma hora y `data_json = { tripId, batchSize }`.
- La entrega sigue siendo por pedido (`deliver`), cada uno con su propia hora. No existe "entregar todos".

### Verificación de ubicación al entregar (avisa y registra, **nunca bloquea**)

Al `deliver` se calcula `delivery_check`:

| Valor | Cuándo |
|---|---|
| `no_location` | No llegó `lat`/`lng` (GPS negado, apagado o sin señal). Tiene prioridad sobre `no_destination`. |
| `no_destination` | El pedido no tiene `lat`/`lng` de destino (p. ej. pedidos manuales: **no hay geocodificación**, pendiente). |
| `far` | Distancia haversine > `DELIVERY_WARN_METERS`, **o** `accuracy` reportada > `DELIVERY_WARN_METERS`. |
| `ok` | Dentro del umbral y con precisión aceptable. |

`delivery_distance_m` (entero, metros) se guarda cuando hay ambos puntos (`ok`/`far`), si no queda null.

**Ráfaga** (campo booleano aparte `delivery_burst`, para no perder `ok`/`far`): solo cuando marca un motorista. Si su entrega anterior (pedido con `driver_id` = él, `delivered_at` < 60 s antes) existe y (ambas ubicaciones de entrega están a más del umbral entre sí, o alguna de las dos es `far`), se marcan **ambas** entregas con `delivery_burst = 1`. El evento `deliver` guarda `{ lat, lng, accuracy, distanceM, check, burstWith? }`; la entrega anterior recibe un evento `burst_flag`.

La web del motorista muestra un aviso no bloqueante si la respuesta trae `deliveryCheck = "far"`. El local/admin ve la observación en pedidos cerrados y el contador en métricas.

### Esquema y migración

Columnas de `orders` agregadas después del esquema inicial: `trip_id TEXT`, `delivery_distance_m INTEGER`, `delivery_check TEXT`, `delivery_burst INTEGER NOT NULL DEFAULT 0` (+ índice `orders_trip`). Al abrir la base el servidor revisa `PRAGMA table_info(orders)` y agrega con `ALTER TABLE ... ADD COLUMN` las que falten; los datos existentes se conservan (entregas antiguas quedan con verificación null y no cuentan en el indicador).

## Formato general

- JSON en request y response (`Content-Type: application/json`).
- Errores: `{ "error": "<codigo>", "message": "<texto en español>" }`.
  Códigos: `bad_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `invalid_transition` 409, `bad_origin` 403, `not_configured` 503.
- Sesión: cookie `sid` HttpOnly, SameSite=Lax, Path=/, Secure si `PUBLIC_ORIGIN` es https.
- Mutaciones con cookie (`POST` excepto webhook) exigen `Origin` (o `Referer`) igual a un `PUBLIC_ORIGIN`. Si no viene ninguno de los dos encabezados, se rechaza.
  Excepción: en el emulador Android el origen es `http://10.0.2.2:4317`; el operador lo agrega a `PUBLIC_ORIGIN` cuando lo necesite.
- Contraseñas: `crypto.scrypt` con salt aleatorio de 16 bytes, comparación `timingSafeEqual`.

## Objeto pedido (`Order`)

```json
{
  "id": "P-1001",                     // id interno legible (P-<n>)
  "source": "manual" | "mercat",
  "externalId": "mercat:STORE:ID" | null,
  "channel": "meson" | "telefono" | "mercat" | "otro",
  "branch": "Melipilla",              // sucursal (texto libre o store_id)
  "customerName": "...", "customerPhone": "...",
  "address": "...", "addressDetail": "...", "notes": "...",
  "lat": null, "lng": null,           // destino si se conoce
  "deliveryFee": 2500,                // tarifa cobrada al cliente (CLP, entero) o null
  "total": 15900 | null,
  "items": [{ "name": "...", "qty": 1 }],
  "promisedAt": "ISO" | null,
  "status": "preparing",
  "externalStatus": "preparing" | null,
  "pickup": false,                    // retiro en local (no se despacha)
  "driverId": 3 | null, "driverName": "Jorge" | null,
  "createdAt": "ISO", "readyAt": null, "departedAt": null, "deliveredAt": null,
  "deliveryLat": null, "deliveryLng": null, "deliveryAccuracy": null,
  "tripId": "V-MVKD...-61EF0F" | null,   // vuelta compartida si salió en lote
  "deliveryDistanceM": 856 | null,       // metros entre ubicación de entrega y destino
  "deliveryCheck": "ok" | "far" | "no_location" | "no_destination" | null,  // null: no entregado o anterior a la función
  "deliveryBurst": false,                // entrega en ráfaga
  "incidents": [{ "at": "ISO", "by": "Jorge", "note": "..." }]
}
```

Los motoristas no reciben `total` ni datos de otros pedidos.

## Rutas

| Ruta | Rol | Request | Respuesta |
|---|---|---|---|
| `GET /api/status` | público | — | `{ needsSetup: bool, setupTokenRequired: bool }` |
| `POST /api/setup` | público, solo si no hay usuarios | `{ name, username, password, setupToken? }` | `{ user }` + cookie |
| `POST /api/login` | público | `{ username, password }` | `{ user }` + cookie. Error 401 genérico. |
| `POST /api/logout` | sesión | — | `{ ok: true }` |
| `GET /api/state` | sesión | query opcional `from`, `to` (YYYY-MM-DD, hora Chile), `branch`, `driverId` para métricas | ver abajo |
| `POST /api/users` | admin | `{ name, username, password, role }` | `{ user }` |
| `POST /api/users/update` | admin | `{ id, active?, password? }` | `{ user }` (desactivar usuario cierra sus sesiones) |
| `POST /api/orders` | admin, local | campos de Order editables: `channel, branch, customerName, customerPhone, address, addressDetail, notes, lat, lng, deliveryFee, total, promisedAt, items` (address obligatorio; `lat`/`lng` opcionales, destino para la verificación de ubicación) | `{ order }` |
| `POST /api/action` | según tabla | `{ orderId, action, driverId?, note?, lat?, lng?, accuracy? }`; para `depart_batch`: `{ action, orderIds }` | `{ order }`; `depart_batch`: `{ tripId, orders }` |
| `POST /api/settings` | admin | `{ month: "YYYY-MM", labor, fuel, maintenance, insurance, other }` (CLP enteros >= 0) | `{ costs }` |
| `GET /api/qr?id=<orderId>` | sesión con acceso al pedido | — | `image/svg+xml` etiqueta con QR + id + dirección |
| `GET /api/export.csv` | admin | mismos filtros que métricas | CSV con un pedido por fila y los 4 tiempos; al final columnas `vuelta`, `distancia_entrega_m`, `verificacion_ubicacion`, `rafaga` (`si`/`no` en entregados) |
| `POST /api/webhooks/mercat` | encabezado `X-Webhook-Secret` | evento Mercat | `200 { ok: true, applied: bool, duplicate: bool }` |
| `POST /api/sheets/sync` | admin | — | `{ sheets: SheetsStatus }`; 503 `not_configured` si la copia está deshabilitada |

### `GET /api/state`

```json
{
  "user": { "id": 1, "name": "...", "username": "...", "role": "admin" },
  "serverTime": "ISO",
  "deliveryWarnMeters": 300,  // umbral vigente, para los textos de aviso
  "orders": [Order],          // activos + entregados/cerrados de las últimas 24 h; driver: solo los suyos
  "drivers": [{ "id": 3, "name": "Jorge", "active": true }],   // admin/local
  "users": [User],            // solo admin
  "branches": ["Melipilla"],  // distintas sucursales vistas
  "metrics": Metrics,         // admin y local
  "costs": Costs | null,      // solo admin
  "sheets": SheetsStatus      // solo admin
}
```

`Metrics` (filtradas por `from`/`to` sobre `created_at` en hora Chile; por defecto últimos 7 días):

```json
{
  "from": "2026-10-16", "to": "2026-10-22",
  "prep":   { "avgMinutes": 18.2, "count": 40 },   // ready - created
  "wait":   { "avgMinutes": 6.1,  "count": 38 },   // departed - ready
  "route":  { "avgMinutes": 21.4, "count": 37 },   // delivered - departed
  "total":  { "avgMinutes": 45.0, "count": 37 },   // delivered - created
  "deliveredCount": 37, "failedCount": 1, "canceledCount": 2,
  "locationFlaggedCount": 3,   // entregados con far, no_location o ráfaga (cada pedido cuenta una vez)
  "locationChecks": { "ok": 30, "far": 2, "noLocation": 1, "noDestination": 4, "burst": 1 },
  "byDriver": [{ "driverId": 3, "name": "Jorge", "deliveries": 20, "routeAvgMinutes": 19.0 }],
  "byChannel": [{ "channel": "mercat", "orders": 30, "totalAvgMinutes": 44.0 }]
}
```
Solo se promedian intervalos con ambos extremos presentes y fin >= inicio; `count` dice cuántos pedidos sustentan el promedio.

`Costs`:

```json
{
  "month": "2026-10",
  "labor": 0, "fuel": 0, "maintenance": 0, "insurance": 0, "other": 0,
  "totalCost": 0,
  "deliveredInMonth": 37,          // por fecha de entrega en hora Chile, todas las sucursales
  "costPerDelivery": 1234.5 | null,
  "feesInMonth": 92500,            // suma deliveryFee de esos entregados
  "feesMinusCost": -500
}
```
Se guarda un registro de costos **por mes** (tabla `monthly_costs`, PK `month`), así queda historial. `GET /api/state?costMonth=YYYY-MM` elige el mes (defecto mes actual Chile).

## Copia a Google Sheets

Decisión del usuario: **SQLite es la fuente de verdad**. Google Sheets es solo una copia automática de **solo lectura** para el negocio, alimentada por el servidor (`sheets.mjs`). La app nunca lee la hoja; lo que se edite allá se pierde en la siguiente copia.

- Habilitada solo si están `GOOGLE_SHEETS_ID` y `GOOGLE_SERVICE_ACCOUNT_FILE`. Si falta alguno: deshabilitada, sin errores.
- Autenticación con cuenta de servicio sin dependencias: JWT RS256 firmado con `node:crypto` (scope `https://www.googleapis.com/auth/spreadsheets`), canjeado en `https://oauth2.googleapis.com/token`; el token se reutiliza hasta 1 min antes de vencer. Nunca se registran la clave ni el token.
- Cada cambio de pedido (todo lo que escribe en `order_events`: acciones, pedidos manuales, webhook) y cada `POST /api/settings` marca la copia como pendiente. Un temporizador en segundo plano (`unref`) reescribe la hoja cuando hay cambios pendientes y pasó `GOOGLE_SHEETS_INTERVAL_SECONDS`. Una sola copia a la vez; ante error, reintento con espera creciente (hasta 30 min) y timeout de red de 15 s por llamada. Nunca bloquea ni hace fallar una petición de usuario ni el webhook.
- Reescritura completa e idempotente: `spreadsheets.get` (crea con `batchUpdate addSheet` las pestañas que falten), `values:batchClear` y `values:batchUpdate` con `valueInputOption: RAW`.
- Pestaña `Pedidos`: encabezado + un pedido por fila, creados en los últimos `GOOGLE_SHEETS_DAYS` días (hora Chile), **sin retiros (pickup)**. Columnas: id, origen, canal, sucursal, cliente, dirección, motorista, estado, estado externo, tarifa (CLP), monto pedido (CLP), creado, listo, salida, entregado (`YYYY-MM-DD HH:mm` hora Chile), min hasta listo, min espera retiro, min reparto, min total, incidencias, vuelta (`trip_id`), distancia de entrega (m) (`delivery_distance_m`), verificación de ubicación (`delivery_check`: OK / Lejos del destino / Sin ubicación / Sin destino) y ráfaga (`sí`/`no` solo en entregados). No incluye el teléfono del cliente.
- Pestaña `Resumen`: métricas de los últimos 7 y 30 días (mismo cálculo que `Metrics`, con cantidad de pedidos que sustentan cada promedio y `locationFlaggedCount`) y costos del mes actual (`Costs`).
- Todo texto que empiece con `=`, `+`, `-` o `@` se antepone con `'`.

`SheetsStatus` (en `GET /api/state` solo admin, y respuesta de `POST /api/sheets/sync`):

```json
{ "enabled": true, "lastSyncAt": "ISO" | null, "lastError": "texto sin datos sensibles" | null, "pendingChanges": false }
```

`POST /api/sheets/sync` (admin, con validación de Origin) fuerza una copia ignorando intervalo y espera de reintento; espera hasta 20 s y responde el estado (si tarda más, la copia sigue en segundo plano).

Pasos de configuración: ver README. **No se ha probado contra Google real**; las pruebas usan un servidor falso local.

## Webhook Mercat

Encabezado `X-Webhook-Secret` comparado en tiempo constante con `MERCAT_WEBHOOK_SECRET`.
Cuerpo: `{ event_id, event_type, event_timestamp, api_version, client_id, event_data }`.

- `event_type` admitidos: `orders.create`, `orders.update`. Otros => 200 `{ ok: true, applied: false, ignored: true }`.
- `event_data` campos leídos (tolerante a ausencias): `id`, `store_id`, `status`, `created_at`, `promised_at` o `delivery_time`, `user_name`/`name`, `user_phone`/`phone`, `user_address`, `apartment`/`department`, `delivery_notes`/`notes`, `latitude`, `longitude`, `delivery_price`, `total`, `products` (`[{ name, quantity }]`), `delivery_type`/`type`.
- Id externo: `mercat:<store_id>:<id>`. Deduplicación por `event_id` (tabla `webhook_events`).
- Se aplica la instantánea solo si `event_timestamp` > último aplicado para ese pedido. Igual o menor: se registra como recibido, `applied: false`.
- Estado remoto se guarda en `external_status`. Efectos locales: `ready` => si local está `preparing`, pasa a `ready` con `ready_at = event_timestamp`. `canceled`/`failed` => si no está `delivered`, pasa a `canceled`/`failed`. `completed` **no** marca entrega local.
- `created_at` de Mercat se usa como `createdAt` del pedido.
- Si `delivery_type`/`type` indica retiro (`pickup`, `takeaway`, `retiro`), el pedido se guarda con `pickup: true`: no se puede asignar ni despachar, no aparece en la lista de despacho y no entra en métricas de reparto ni costos. (Campo `pickup` en Order, por defecto false.) Pendiente confirmar con Mercat los valores reales de este campo.
- Responder rápido (< 10 s); procesamiento síncrono en transacción.

## Interfaz web (`public/`)

- Una sola página (`index.html`, `app.js`, `style.css`), sin frameworks ni CDN, en español de Chile, apta para teléfono (WebView) y escritorio.
- Pantallas según estado: alta inicial, login, panel.
- Panel admin/local: crear pedido manual, lista por estado, asignar motorista, marcar listo, cancelar, imprimir QR, lector de código (campo de texto + evento Android), métricas con filtros fecha/sucursal, costos del mes (admin), usuarios (admin), exportar CSV (admin).
- Panel motorista: tarjetas grandes de sus pedidos agrupadas en En ruta / Listos para retirar / En preparación, con botón **Salí** (con confirmación), **Entregado** (con confirmación, pide GPS opcional vía `navigator.geolocation`; si la respuesta es `far` muestra un aviso no bloqueante con la distancia), **Incidencia**, enlace “Abrir en mapa” (`https://www.google.com/maps/search/?api=1&query=...`), llamar al cliente (`tel:`).
- Salida en lote (motorista): en "Listos para retirar" cada tarjeta tiene una casilla; una barra fija muestra **Salí con N pedidos** (diálogo que lista ids y direcciones antes de confirmar). La selección vive en memoria de la página, sobrevive al refresco de 15 s y se poda a los pedidos que siguen listos. Al escanear un pedido listo el diálogo ofrece "Salir solo con este" o "Agregar a la salida". El panel del local no tiene salida en lote (usa "Registrar salida" por pedido).
- Panel local/admin: pedidos cerrados muestran la verificación de ubicación (distancia, sin ubicación, sin destino, ráfaga) y la insignia "Revisar ubicación"; métricas con el contador "Entregas con observación de ubicación".
- Refresco cada 15 s con `GET /api/state`, sin refrescar si hay un input con foco con contenido o un `<dialog>` abierto.
- Integración Android: escuchar `window.addEventListener('android-scan', e => e.detail.text)`. El texto escaneado es el contenido del QR. Formato del QR: `DESPACHO:<orderId>`. Al recibirlo: buscar el pedido, mostrarlo y pedir confirmación de la acción siguiente válida (no ejecutar sin confirmar).
- Si `window.AndroidApp` existe (solo métodos `scan()` y `openSettings()`), mostrar botón “Escanear QR” que llama `AndroidApp.scan()`.

## Android (`android/`)

- Java, paquete `cl.osake.despachos`, minSdk 23, compile/target 36, AGP 8.13.x, Gradle 8.13 wrapper, JDK 17.
- WebView con JS y DOM storage, cookies; carga la URL de servidor guardada en SharedPreferences; primera vez pide URL.
- Solo HTTPS, excepto en build debug donde se permite `http://10.0.2.2:4317` (network security config de debug).
- Toolbar/menú: Escanear QR, Actualizar, Configurar servidor. Cambiar servidor limpia cookies.
- Escaneo con Google Code Scanner (`com.google.android.gms:play-services-code-scanner:16.1.0`); resultado enviado como `window.dispatchEvent(new CustomEvent('android-scan', {detail:{text}}))` con el texto escapado vía JSON.
- `addJavascriptInterface` con objeto `AndroidApp` que expone solo `scan()` y `openSettings()` (`@JavascriptInterface`), y solo si la página cargada pertenece al origen configurado.
- Geolocalización: `WebChromeClient.onGeolocationPermissionsShowPrompt` + permiso runtime `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION`; sin segundo plano.
- Enlaces `tel:` y mapas se abren con Intent externo.
- Atrás con `OnBackPressedDispatcher` (AndroidX Activity 1.10.1).
- Workflow `.github/workflows/android.yml`: ubuntu-24.04, JDK 17, `android-actions/setup-android`, `./gradlew :app:assembleDebug :app:lintDebug`, sube APK (`despachos-android-debug`) e informe lint, retención 14 días.
