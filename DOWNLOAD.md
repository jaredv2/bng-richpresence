# BuildNow — Rich Presence

Show your BuildNow game on Discord. No setup, no code.

---

## What you get

- Your Discord shows if you are **In Lobby** or **In Game**
- Shows **game mode**: Free Mode, Lategame Zone Wars, Boxfights, Boxfights 2v2
- Shows **Duo** when playing duo
- Shows **players** and if you are **In Party**
- Works only for **BuildNow GG** on CrazyGames

---

## Requirements

- Windows 10/11 (or Mac with Node)
- Google Chrome or Edge
- Violentmonkey extension
- Discord app open on your computer

---

## Download

| File | What it is |
|------|------------|
| [**BuildNowTray.exe**](photon-sniffer/tray/dist/BuildNowTray.exe) | Run in background, shows icon in tray. Runs decryptor + Discord presence. |
| [**Rich Presence script (locked)**](photon-sniffer/photon-sniffer-presence-only.locked.user.js) | Click to install. Read-only for Violentmonkey. |
| [Rich Presence script (plain)](photon-sniffer/photon-sniffer-presence-only.user.js) | Same, readable version |

> If the exe is not built yet, run `pip install -r photon-sniffer/tray/requirements-tray.txt` then `photon-sniffer/tray/build-exe.bat`

---

## How to install

### 1. Install Violentmonkey
Open Chrome → [Violentmonkey](https://addons.mozilla.org/en-US/firefox/addon/violentmonkey/) / [Chrome Web Store](https://chrome.google.com/webstore/detail/violentmonkey) → Add to Chrome.

### 2. Install the script
Click **Rich Presence script (locked)** above. Violentmonkey will ask to install → click **Confirm**. It is read-only, you cannot edit it.

### 3. Run the tray app
Download **BuildNowTray.exe** → double click. It will hide to the tray (bottom right, near clock). Keep it running.

### 4. Play
Open [BuildNow GG on CrazyGames](https://www.crazygames.com/game/buildnow-gg) and play. Your Discord profile will update automatically. No login needed.

---

## How to close

Right click the tray icon → **Quit**.

---

## Note

- The script is encrypted and read-only. To update, reinstall the locked file.
- Keep Discord and the tray app open while playing.
- If Discord does not show, restart Discord and the tray app.

