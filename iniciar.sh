#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "No se encontró Node.js. Instala Node 22.13 o superior." >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Instalando dependencias..."
  npm install --omit=dev
fi
exec node server.mjs
