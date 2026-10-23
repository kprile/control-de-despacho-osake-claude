# Control de despachos Osake

Piloto para registrar los tiempos de cada pedido de delivery (creado → listo → salida → entregado) y calcular el costo promedio por entrega. Incluye un panel web para el local y la administración, una vista para motoristas y un cliente Android.

- Contexto del negocio, decisiones y pendientes: [docs/CONTEXTO.md](docs/CONTEXTO.md)
- Especificación técnica (API, estados, webhook): [docs/CONTRATO.md](docs/CONTRATO.md)
- Cliente Android: [android/README.md](android/README.md)

## Requisitos

- Node.js 22.13 o posterior (se recomienda 24).

## Uso local

```sh
npm install
npm start          # http://127.0.0.1:4317
```

En Windows: doble clic en `Iniciar.cmd`. Al abrir la página por primera vez se crea el administrador (contraseña de mínimo 6 caracteres).

La configuración se toma de variables de entorno o de un archivo `.env` (ver `.env.example`). La base queda en `data/despachos.sqlite` y no se sube al repositorio.

## Pruebas

```sh
npm test
```

## Copia a Google Sheets (opcional)

El servidor puede mantener una copia de **solo lectura** de los pedidos y un resumen en una hoja de Google para el negocio. La base SQLite sigue siendo la fuente de verdad: lo que se edite en la hoja se pierde en la siguiente copia. Detalle técnico en [docs/CONTRATO.md](docs/CONTRATO.md#copia-a-google-sheets).

1. En [Google Cloud Console](https://console.cloud.google.com/) crea un proyecto (o usa uno existente).
2. En "APIs y servicios" → "Biblioteca", habilita **Google Sheets API**.
3. En "IAM y administración" → "Cuentas de servicio", crea una cuenta de servicio (no necesita roles del proyecto).
4. En esa cuenta, "Claves" → "Agregar clave" → "JSON". Descarga el archivo **directamente al servidor**, fuera del repositorio (por ejemplo `/etc/despachos/credenciales/service-account.json`, con permisos solo para el usuario que corre el servidor). **Nunca lo subas al repositorio ni lo pegues en un chat o correo.**
5. Crea la hoja de cálculo en Google Sheets y compártela con el `client_email` de la cuenta de servicio (aparece dentro del JSON, termina en `iam.gserviceaccount.com`) como **Editor**. A las demás personas compártela solo como Lector.
6. Define en `.env`: `GOOGLE_SHEETS_ID` (la parte entre `/d/` y `/edit` de la URL de la hoja) y `GOOGLE_SERVICE_ACCOUNT_FILE` (ruta al JSON). Opcionales: `GOOGLE_SHEETS_INTERVAL_SECONDS` (60) y `GOOGLE_SHEETS_DAYS` (90). Reinicia el servidor.
7. En el panel, pestaña **Costos** → "Google Sheets", revisa el estado o usa **Sincronizar ahora**. El servidor crea las pestañas `Pedidos` y `Resumen` si no existen.

Si la clave se filtra, elimínala en Google Cloud ("Claves" de la cuenta de servicio) y crea otra.

## Estado actual

| Parte | Estado |
|---|---|
| Backend, panel web y métricas | Implementado y probado con pruebas automáticas y en navegador. |
| Pedidos manuales (mesón/teléfono) | Implementado. |
| Webhook Mercat (`POST /api/webhooks/mercat`) | Implementado y probado con eventos simulados. **No hay credenciales ni tráfico real**: no está integrado. |
| Restô | Sin conector; falta acceso del proveedor. |
| APK Android (debug) | Compila en GitHub Actions. **No probado en un teléfono real.** |
| Copia a Google Sheets | Implementada y probada contra un servidor falso local. **No probada contra Google real.** |
| Servidor compartido HTTPS | No desplegado. Para producción definir `HOST`, `PUBLIC_ORIGIN` (https) y `SETUP_TOKEN`. |

No subir `.env`, bases de datos, credenciales ni llaves de firma.
