# Build from source — Rich Presence

## Requirements

- Node.js 18+ — https://nodejs.org
- Python 3.11+ (for tray exe only)
- Git

## 1. Get code

```ps
git clone https://github.com/jaredv2/bng-richpresence.git
cd bng-richpresence
npm install
```

## 2. Run decryptor + presence

```ps
node photon-sniffer/decryptor.js
# → http://127.0.0.1:8765/status is {ok:true}
```

New terminal:

```ps
set DISCORD_CLIENT_ID=123456789012345678
node photon-sniffer/discord-presence.js
```

Or build tray exe (both headless in tray):

```ps
pip install -r photon-sniffer/tray/requirements-tray.txt
photon-sniffer\tray\build-exe.bat
# → dist/BuildNowTray.exe  (double click, lives in tray)
```

## 3. Install userscript
`photon-sniffer/photon-sniffer-presence-only.user.js`

Chrome → Violentmonkey → Install from file → Confirm.

## 4. Play

Open BuildNow GG on CrazyGames. Discord shows `Free Mode` / `Lategame Zone Wars` / `Boxfights` etc, `In Lobby` → `In Game • 1/12 players`, `Duo` and `In Party` when applicable. Close tab or quit tray → presence clears.

## Verify

- `http://127.0.0.1:8765/presence` — correct `gameMode` and `players`
- Discord profile updates

