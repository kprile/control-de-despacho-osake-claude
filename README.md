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

## Estado actual

| Parte | Estado |
|---|---|
| Backend, panel web y métricas | Implementado y probado con pruebas automáticas y en navegador. |
| Pedidos manuales (mesón/teléfono) | Implementado. |
| Webhook Mercat (`POST /api/webhooks/mercat`) | Implementado y probado con eventos simulados. **No hay credenciales ni tráfico real**: no está integrado. |
| Restô | Sin conector; falta acceso del proveedor. |
| APK Android (debug) | Compila en GitHub Actions. **No probado en un teléfono real.** |
| Servidor compartido HTTPS | No desplegado. Para producción definir `HOST`, `PUBLIC_ORIGIN` (https) y `SETUP_TOKEN`. |

No subir `.env`, bases de datos, credenciales ni llaves de firma.
