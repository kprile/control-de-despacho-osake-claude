# Despachos Osake – cliente Android

App Android (Java) que muestra en un WebView la web del piloto de despachos y agrega
escaneo de QR con Google Code Scanner y ubicación puntual al marcar una entrega.
El contrato con el backend y la web está en `../docs/CONTRATO.md`.

## Requisitos

- JDK 17.
- Android SDK con `platforms;android-36` (Android Studio o `commandlinetools`), variable
  `ANDROID_HOME` apuntando al SDK (o un `local.properties` con `sdk.dir=...`, que **no** se sube a git).
- Gradle no hace falta instalarlo: se usa el wrapper (`./gradlew`, Gradle 8.13).
- Versiones: AGP 8.13.2, compileSdk/targetSdk 36, minSdk 23 (Android 6).
- El teléfono necesita Google Play Services para el lector QR.

## Compilar

```bash
cd android
./gradlew :app:assembleDebug        # APK debug en app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:lintDebug            # informe en app/build/reports/lint-results-debug.html
```

Si `./gradlew` da "Permission denied": `chmod +x gradlew`.

El workflow `.github/workflows/android.yml` hace lo mismo en cada push que toque `android/`
y deja como artefactos el APK (`despachos-android-debug`) y el informe lint (`informe-android`),
por 14 días. No hay firma de release ni secretos: el APK es debug.

## Instalar el APK debug

Con el teléfono en modo desarrollador y depuración USB (o con un emulador abierto):

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Apuntar al servidor

Al abrir la app por primera vez pide la dirección del servidor; después se cambia con el menú
**Configurar servidor**. Cambiar de servidor borra cookies (cierra la sesión) y datos web, y recarga.

- Release y debug: solo `https://...` (por ejemplo `https://despachos.ejemplo.cl`).
  El servidor debe tener ese origen en `PUBLIC_ORIGIN`.
- Solo en build debug, para el emulador: `http://10.0.2.2:4317` (10.0.2.2 es el equipo anfitrión
  visto desde el emulador). Hay que agregar ese origen al servidor, p. ej.
  `PUBLIC_ORIGIN=http://127.0.0.1:4317,http://10.0.2.2:4317`, y escuchar en una interfaz alcanzable
  (con `HOST=127.0.0.1` el emulador sí llega, porque 10.0.2.2 se traduce al loopback del anfitrión).
  Ojo: con `http://` el navegador no considera la página segura, así que `navigator.geolocation`
  no funcionará en ese modo; la ubicación solo se puede probar con https.

## Comportamiento

- Barra superior: **Escanear QR**, **Actualizar** y (en el menú ⋮) **Configurar servidor**.
- Escaneo: al leer un QR se envía a la web
  `window.dispatchEvent(new CustomEvent('android-scan', {detail:{text}}))` (texto escapado como JSON;
  el QR de un pedido contiene `DESPACHO:P-1001`). Cancelar no hace nada; los errores se muestran con un
  aviso (falta Play Services, módulo del lector aún descargándose).
- `window.AndroidApp` expone solo `scan()` y `openSettings()`, y solo actúan si la página visible es
  del servidor configurado.
- Navegación: lo del mismo origen (esquema + host + puerto) queda en la app; `tel:`, `geo:`, mapas,
  `mailto:`/`sms:` y cualquier otro sitio se abren con la app externa correspondiente. Otros esquemas
  (`intent:`, `file:`, etc.) se bloquean.
- Ventanas nuevas (`target=_blank` / `window.open`, p. ej. la etiqueta QR `/api/qr?id=...`): si son del
  mismo origen se cargan en el mismo WebView (conserva la sesión; se vuelve con **Atrás**); si son de otro
  origen se abren en el navegador. Solo se aceptan si vienen de un toque del usuario.
- Descargas (p. ej. `/api/export.csv`): solo del origen configurado, con `DownloadManager` y la cookie de
  sesión del WebView. Android 10+ guarda en **Descargas**; Android 6–9 en la carpeta de la app
  (se abre desde la notificación).
- Ubicación: solo para el origen configurado, previa autorización de ubicación de Android (precisa o
  aproximada). Sin ubicación en segundo plano.
- Error de carga de la página principal (sin red, servidor caído, certificado inválido): pantalla propia
  con **Reintentar** y **Configurar servidor**. Los certificados inválidos nunca se aceptan.
- Atrás: retrocede en el historial del WebView; sin historial, sale de la app.
- Rotación: se guarda y restaura el estado del WebView (`onSaveInstanceState`).
- Red: release solo HTTPS (`network_security_config.xml`); debug reemplaza ese archivo
  (`src/debug/res/xml/`) para permitir HTTP solo hacia `10.0.2.2`. Android 6 (API 23) ignora esa
  configuración, por eso `usesCleartextTraffic` se fija por tipo de build (debug `true`, release `false`).
- Sin respaldo de datos (`allowBackup=false`): la sesión y la URL no se copian a otros equipos.

## Qué NO está verificado

- Compila y pasa lint (`assembleDebug` + `lintDebug`, solo avisos de versiones más nuevas disponibles).
- **No se ha probado en un teléfono real ni en emulador**: escaneo QR, permisos de ubicación, descargas
  del CSV, apertura de `tel:`/mapas, rotación y pantalla de error están implementados pero sin prueba
  manual.
- Imprimir la etiqueta QR desde el teléfono no está resuelto (el WebView no implementa `window.print()`);
  la etiqueta se ve en la app, pero imprimir conviene hacerlo desde un computador.
- No hay build release firmado.
