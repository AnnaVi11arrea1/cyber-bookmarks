# NEURAL//LINKS — Cyberpunk Bookmarks

A neon side-panel bookmark manager for Chrome, with an optional **Signal Feed** that pulls in your LinkedIn and dev.to notifications, Stripe sales, and security alerts from your own Linux server.

## Features

- **Bookmarks in the side panel.** Drag to reorder, drop onto a folder to nest it, and group items into folders with Ctrl/Shift+click and then **⧉ GROUP** (Ctrl+G). Right-click an item for more options.
- **Full-screen view.** Click **⤢** to open the same tree in a tab.
- **Signal Feed.** It checks every 5 minutes and shows new items as a badge count on the toolbar icon. It can also send desktop alerts.
- **Your real bookmarks.** It edits Chrome's own bookmarks, so changes sync wherever Chrome sync does.

## Install the extension

1. Download or clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the project folder (the one with `manifest.json`).
4. Pin the extension, then click its icon or press **Alt+Shift+L** to open the panel.

## Set up the Signal Feed (optional)

Click the **⚙** icon in the **SIGNAL FEED** section. Every source is optional.

| Source | What you need |
| --- | --- |
| **LinkedIn** | Be logged in to LinkedIn in this browser. |
| **dev.to** | Be logged in to dev.to in this browser. |
| **Stripe sales** | A **restricted** key (`rk_…`) with only **Charges: Read**. Create one under Stripe Dashboard → Developers → API keys. Don't use your secret key. |
| **Server security feed** | A feed URL and token from the server setup below. |

Settings, including keys, are kept only in this browser's local extension storage and are never synced.

## Server security feed (optional)

`server/` contains a small, read-only Python service that reports on a Linux box: pending security updates, required reboots, SSH login activity, fail2ban bans, disk usage, and whether key services are running. It was written for a Jetson but should work on any Debian/Ubuntu machine with systemd and Python 3.8+. It uses only the standard library.

```bash
scp -r server/ you@your-server:~/secfeed
ssh you@your-server 'sudo bash ~/secfeed/install.sh'
```

When it finishes, the script prints a **feed URL** and a **token**. Paste both into the extension's ⚙ settings. Chrome will ask for permission to reach that address.

Configuration lives in `/etc/secfeed.env`:

- `SECFEED_SERVICES`: the systemd services to watch, separated by spaces (default `cloudflared`).
- `SECFEED_PORT`: the port to listen on (default `8890`).

After editing the file, run `sudo systemctl restart secfeed`. You can safely re-run the installer, and it keeps your existing token.

> **Keep it on your LAN.** The service binds to your LAN IP. Don't expose it through a tunnel or port-forward. If `ufw` is active, the installer only allows the feed's port from your server's own subnet, which it detects automatically.

## Troubleshooting

- **A source shows an error:** for LinkedIn or dev.to, log in again in a normal tab, then press **⟳** in the feed.
- **No server items:** from another LAN machine, run `curl -H "Authorization: Bearer <token>" http://<ip>:8890/feed`. On the server, check `systemctl status secfeed`.
- **Too many desktop alerts:** turn them off in ⚙ settings.
