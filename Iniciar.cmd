@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js. Instala Node 22.13 o superior desde https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo Instalando dependencias...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Error al instalar dependencias.
    pause
    exit /b 1
  )
)
node server.mjs
pause
