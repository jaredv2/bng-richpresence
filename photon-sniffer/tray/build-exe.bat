@echo off
REM Build tray exe — run from repo root
REM pip install pyinstaller pystray pillow requests
REM requires Node.js + npm install (for discord-rpc)
REM Build will bundle node_modules so discord-presence works inside exe
if not exist "node_modules\discord-rpc" (
  echo discord-rpc missing — running npm install...
  call npm install
)
pyinstaller --onefile --noconsole --name BuildNowTray --icon=NONE ^
  --add-data "photon-sniffer/decryptor.js;photon-sniffer" ^
  --add-data "photon-sniffer/discord-presence.js;photon-sniffer" ^
  --add-data "node_modules;node_modules" ^
  --add-data "photon-sniffer/captures;photon-sniffer/captures" ^
  --hidden-import=pystray --hidden-import=PIL ^
  photon-sniffer/tray/tray_app.py
echo Built dist/BuildNowTray.exe — runs headless in tray.
echo If 8765 still fails, check %USERPROFILE%\.buildnow-tray.log
