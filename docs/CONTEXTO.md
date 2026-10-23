# Contexto del proyecto

Piloto de control de despachos para Osake (Melipilla, Chile). Resume lo pedido, lo decidido y lo pendiente. La especificación técnica está en [CONTRATO.md](CONTRATO.md).

## Qué pidió el negocio (Scarlet)

- Costo por envío.
- Tiempo promedio desde el pedido hasta que está listo para retirar.
- Tiempo promedio desde que el motorista retira hasta que entrega.
- Aviso sencillo de entrega (botón del motorista).
- Escanear los pedidos cuando salen del local.

Objetivo: trazabilidad de cada pedido y datos reales de demoras y costo; no solo calcular rutas.

## Decisiones confirmadas por el usuario

| Decisión | Detalle |
|---|---|
| App móvil | Solo Android por ahora. |
| Contraseña | Mínimo 6 caracteres (no longitud exacta). |
| Compilación | En GitHub Actions. |
| Repositorio | Todo el trabajo vive en `kprile/control-de-despacho-osake-claude`. |

No hay decisión de usar Google Sheets, Supabase, Cloudflare, Zapier ni Google Maps de pago, ni de publicar en Google Play.

## Qué NO está confirmado

- Composición de la flota (motoristas propios o externos).
- Número de sucursales.
- Acceso a la API de Mercat para este restaurante (no hay credenciales).
- Interfaz técnica de Restô (https://www.resto.cl/); no se encontró documentación pública.
- Qué middleware conecta Mercat con Restô y quién lo administra. Que exista no implica que podamos usarlo.
- Que las direcciones de Mercat lleguen completas o con coordenadas.
- La experiencia de Jorge (8–12 pedidos en 1–1,5 h, después de las 22:00) es histórica, no una medición.

## Métricas

| Tramo | Cálculo | Nota |
|---|---|---|
| Hasta listo | listo − creado | Incluye cola y aceptación; no es "tiempo puro de cocina". |
| Espera de retiro | salida − listo | Por eso hay que marcar "listo", no solo escanear al salir. |
| Reparto | entrega − salida | Cada pedido tiene su propia hora de entrega. |
| Total | entrega − creado | Indicador adicional. |

Costo promedio por entrega = costos de reparto del mes ÷ entregas completadas del mismo mes. Es un costo asignado, no el costo exacto de cada viaje. La tarifa cobrada al cliente se guarda aparte; tarifa − costo no es la rentabilidad del restaurante.

## Mercat (según documentación pública revisada, sin autorización vigente)

- https://developers.mercat.cl/ — credenciales `client_id`/`client_secret` entregadas por su equipo; ellos activan webhooks hacia una URL acordada.
- Eventos `orders.create` y `orders.update`; cuerpo con `event_id`, `event_type`, `event_timestamp`, `api_version`, `client_id`, `event_data`.
- Responder HTTP 200 en menos de 10 s; puede haber reintentos y eventos fuera de orden.
- Autenticación por encabezado `X-Webhook-Secret` (sin firma HMAC documentada).
- Entornos: `https://api.mer-cat.com` y pruebas `https://stage.api.mer-cat.com`.
- No se encontró endpoint público para escribir "entregado" en Mercat: la app guarda sus propios tiempos.

Preguntas para Mercat:
1. Cómo solicitar credenciales para el restaurante y si tiene costo.
2. Si un cambio de estado en Restô llega a Mercat y dispara `orders.update`.
3. Si habilitan el ambiente de pruebas.
4. Qué valores trae el tipo de entrega (delivery vs retiro) y si `created_at` es la hora original del cliente.

## Preguntas para Restô

1. ¿Permiten integrar un desarrollo propio autorizado por el restaurante?
2. ¿Aceptan a un desarrollador independiente / persona natural?
3. ¿Hay API, webhooks, exportación o interfaz autorizada del middleware?
4. ¿Costos, planes y condiciones?
5. ¿Se puede consultar dirección y hora original de pedidos de mesón/teléfono con delivery?
6. ¿Cómo relacionar el ID de Mercat con el de Restô para un mismo pedido?
7. ¿Un cambio de cocina en Restô se propaga a Mercat?
8. ¿Se puede imprimir nuestro QR en su comanda?
9. ¿La integración nueva puede coexistir con la actual?

Hasta tener respuesta, el formulario manual del local cubre mesón/teléfono. No es la integración definitiva.

## Pendientes por etapa

**A. Android en teléfono real:** instalar APK, login, pedidos asignados, QR, salida, entrega, mapa, GPS (concedido/aproximado/negado/apagado), rotación, segundo plano, sesión vencida.

**B. Servidor compartido:** alojamiento, dominio y HTTPS, `PUBLIC_ORIGIN`, `SETUP_TOKEN` durante el alta, respaldos y restauración, permisos de local por sucursal, pruebas desde varias redes.

**C. Integraciones:** autorización del comercio, credenciales y URL del webhook, delivery vs retiro, significado real de estados, eventos con igual timestamp, recuperación de pedidos omitidos, correlación Mercat–Restô, claves solo en el servidor.

**D. Piloto operativo:** quién marca listo, asigna y confirma retiro; qué es entrega e incidencia; categorías de costo; 2–4 semanas de datos reales (recomendación, no plazo acordado). Después: salida en lote, validación de cercanía al destino, kilómetros, rutas, Sheets, notificaciones.

## Criterios para considerar operativo el piloto

- [ ] El Android instala, abre y entra al servidor correcto.
- [ ] Local y teléfonos comparten los mismos pedidos y cambios.
- [ ] Cada motorista ve solo sus pedidos.
- [ ] Un pedido de delivery llega automáticamente desde la fuente autorizada.
- [ ] Los pedidos que llegan a ambas plataformas no se duplican.
- [ ] Hay solución para mesón/teléfono.
- [ ] Listo, salida y entrega se registran en el momento correcto.
- [ ] El QR identifica el pedido correcto y exige confirmación.
- [ ] El local ve la entrega dentro del plazo acordado.
- [ ] Los promedios muestran cuántos pedidos los sustentan.
- [ ] Costos y entregas del mismo período, con tarifa separada.
- [ ] Incidencias y desconexiones sin inventar entregas.
- [ ] Respaldo y restauración probados.
- [ ] Flujo completo probado con el restaurante y motoristas reales.
