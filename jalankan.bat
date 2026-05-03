@echo off
title Sistem Antrian Digital SPMB
color 1F
cls

cd /d "%~dp0"

set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "NODE_CMD="

:: ── Cek Node.js portable ──────────────────────────────────────────────────────
if exist "runtime\node.exe" (
    set "NODE_CMD=%CD%\runtime\node.exe"
    goto START_SERVER
)

:: ── Cek subfolder runtime ─────────────────────────────────────────────────────
for /d %%D in ("runtime\node-v*") do (
    if exist "%%D\node.exe" (
        xcopy /s /q "%%D\*" "runtime\" >nul
        rmdir /s /q "%%D" >nul 2>&1
        if exist "runtime\node.exe" (
            set "NODE_CMD=%CD%\runtime\node.exe"
            goto START_SERVER
        )
    )
)

:: ── Cek Node.js sistem ────────────────────────────────────────────────────────
node --version >nul 2>&1
if %errorlevel% equ 0 (
    set "NODE_CMD=node"
    goto START_SERVER
)

:: ── Download Node.js ─────────────────────────────────────────────────────────
color 0E
echo  [INFO] Node.js belum ada. Mengunduh otomatis (sekitar 30MB)...
if not exist "runtime" mkdir "runtime"
"%PS_EXE%" -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v18.20.8/node-v18.20.8-win-x64.zip' -OutFile 'runtime\node-win.zip' -UseBasicParsing"
if not exist "runtime\node-win.zip" (
    color 4F
    echo  [ERROR] Download gagal! Install Node.js manual: https://nodejs.org/en/download
    pause & exit /b 1
)
echo  Mengekstrak...
"%PS_EXE%" -Command "Expand-Archive -Path 'runtime\node-win.zip' -DestinationPath 'runtime\tmp' -Force"
xcopy /s /q "runtime\tmp\node-v18.20.8-win-x64\*" "runtime\" >nul
rmdir /s /q "runtime\tmp" >nul 2>&1
del "runtime\node-win.zip" >nul 2>&1
if not exist "runtime\node.exe" (
    color 4F
    echo  [ERROR] Ekstraksi gagal!
    pause & exit /b 1
)
color 2F
echo  [OK] Node.js berhasil disiapkan!
color 1F
set "NODE_CMD=%CD%\runtime\node.exe"

:START_SERVER
cls
echo.
echo  ============================================
echo   SISTEM ANTRIAN DIGITAL SPMB v4.6
echo   Dikembangkan oleh Cahyana Wijaya
echo  ============================================
echo.
echo   Kiosk   : http://localhost:3000
echo   Display : http://localhost:3000/display
echo   Loket   : http://localhost:3000/loket
echo   Admin   : http://localhost:3000/admin
echo.
echo   Server akan restart otomatis jika berhenti.
echo   Tekan Ctrl+C untuk menghentikan server.
echo  ============================================
echo.

start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000/admin"

:LOOP
"%NODE_CMD%" "%~dp0server.js"
echo.
echo  [WARN] Server berhenti. Restart dalam 5 detik... (Ctrl+C untuk keluar)
timeout /t 5 /nobreak >nul
echo  [INFO] Memulai ulang server...
echo.
goto LOOP
