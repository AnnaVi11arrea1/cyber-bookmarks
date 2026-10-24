#!/usr/bin/env python3
"""Read-only security status feed for the NEURAL//LINKS extension.

GET /feed with "Authorization: Bearer <SECFEED_TOKEN>" returns
    {"host": ..., "generated": <epoch>, "items": [{id, level, title, detail, ts}, ...]}
where level is one of ok | info | warn | crit.

LAN-only by design: bind it to the Jetson's LAN address and do NOT route it through the
Cloudflare tunnel. It only reads state; it never changes anything on the box.
Standard library only, Python 3.8+.
"""
import hashlib
import hmac
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ["SECFEED_TOKEN"]
BIND = os.environ.get("SECFEED_BIND", "127.0.0.1")
PORT = int(os.environ.get("SECFEED_PORT", "8890"))
SERVICES = os.environ.get("SECFEED_SERVICES", "cloudflared").split()
CACHE_SECONDS = 60
DAY = 86400

# First time each item id was seen, so state-style items keep a stable timestamp between polls.
first_seen = {}


def run(cmd, timeout=60):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.stdout, p.stderr
    except (OSError, subprocess.TimeoutExpired) as e:
        return "", str(e)


def item(key, level, title, detail="", ts=None):
    ident = hashlib.sha1("|".join(map(str, key)).encode()).hexdigest()[:16]
    return {
        "id": ident,
        "level": level,
        "title": title,
        "detail": detail,
        "ts": int(first_seen.setdefault(ident, ts or time.time())),
    }


def bucket(n):
    """Round a count down to 1/10/50/100/500... so ids only change when it grows meaningfully."""
    for b in (1000, 500, 100, 50, 10, 1):
        if n >= b:
            return b
    return 0


def plural(n, word):
    return "{} {}{}".format(n, word, "" if n == 1 else "s")


# ---------- checks ----------

def check_apt():
    out, _ = run(["apt", "list", "--upgradable"])
    lines = [l for l in out.splitlines() if "[upgradable" in l]
    pkgs = [l.split("/")[0] for l in lines]
    security = sorted(l.split("/")[0] for l in lines if "-security" in l)
    items = []
    if security:
        level = "crit" if any(re.search(r"openssh|openssl|sudo|linux-image|libc6", p) for p in security) else "warn"
        detail = ", ".join(security[:10]) + (" …" if len(security) > 10 else "")
        items.append(item(("apt-sec",) + tuple(security), level, plural(len(security), "security update") + " pending", detail))
    else:
        items.append(item(("apt-clean", datetime.now().date()), "ok", "No pending security updates",
                          plural(len(pkgs), "other upgrade") + " available" if pkgs else ""))

    try:
        age_days = (time.time() - os.path.getmtime("/var/lib/apt/lists")) / DAY
        if age_days > 3:
            items.append(item(("apt-stale", int(age_days)), "warn", "Package lists are {} days old".format(int(age_days)),
                              "apt update hasn't run lately, so pending updates may be missing."))
    except OSError:
        pass
    return items


def check_reboot():
    if not os.path.exists("/var/run/reboot-required"):
        return []
    try:
        with open("/var/run/reboot-required.pkgs") as f:
            pkgs = ", ".join(sorted(set(f.read().split())))
    except OSError:
        pkgs = ""
    return [item(("reboot", os.path.getmtime("/var/run/reboot-required")), "warn", "Reboot required to finish updates",
                 pkgs, os.path.getmtime("/var/run/reboot-required"))]


def check_apt_history():
    """Updates installed in the last 7 days, one item per day (unattended-upgrades runs many small batches)."""
    try:
        with open("/var/log/apt/history.log", errors="replace") as f:
            text = f.read()
    except OSError:
        return []
    days = {}  # date -> [names, latest ts]
    for block in text.split("\n\n"):
        start = re.search(r"Start-Date: (\S+)\s+(\S+)", block)
        changed = re.search(r"^(Upgrade|Install): (.*)$", block, re.M)
        if not (start and changed):
            continue
        ts = datetime.strptime(start.group(1) + " " + start.group(2), "%Y-%m-%d %H:%M:%S").timestamp()
        if time.time() - ts > 7 * DAY:
            continue
        day = days.setdefault(start.group(1), [[], 0])
        day[0].extend(re.findall(r"([\w.+-]+):\w+ \(", changed.group(2)))
        day[1] = max(day[1], ts)
    items = []
    for date, (names, ts) in days.items():
        names = sorted(set(names))
        detail = ", ".join(names[:10]) + (" …" if len(names) > 10 else "")
        # The id includes the count so a later batch on the same day shows up as a fresh item.
        items.append(item(("apt-hist", date, len(names)), "info", "Installed {}".format(plural(len(names), "update")), detail, ts))
    return items


def is_public(ip):
    try:
        return not ipaddress.ip_address(ip).is_private
    except ValueError:
        return True


def check_ssh():
    out, err = run(["journalctl", "-u", "ssh", "-u", "sshd", "--since", "24 hours ago", "-o", "short-unix", "--no-pager"])
    if "insufficient permissions" in err or ("No journal files" in err and not out):
        return [item(("ssh-perm",), "warn", "Can't read SSH logs", "Add the secfeed user to the systemd-journal group.")]

    items = []
    failed, ips = 0, {}
    for line in out.splitlines():
        ts = float(line.split(" ", 1)[0]) if line[:1].isdigit() else time.time()
        ok = re.search(r"Accepted (\S+) for (\S+) from (\S+)", line)
        if ok:
            method, user, ip = ok.groups()
            level = "warn" if is_public(ip) else "info"
            items.append(item(("ssh-ok", ts, user, ip), level, "SSH login: {} from {}".format(user, ip), "via " + method, ts))
            continue
        bad = re.search(r"(?:Failed \S+ for (?:invalid user )?\S+|Invalid user \S+) from (\S+)", line)
        if bad:
            failed += 1
            ips[bad.group(1)] = ips.get(bad.group(1), 0) + 1

    if failed:
        top = sorted(ips.items(), key=lambda kv: -kv[1])[:3]
        detail = "Top sources: " + ", ".join("{} ({})".format(ip, n) for ip, n in top)
        level = "warn" if failed >= 20 else "info"
        items.append(item(("ssh-fail", datetime.now().date(), bucket(failed)), level,
                          "{} in the last 24h".format(plural(failed, "failed SSH login")), detail))
    return items


def check_fail2ban():
    try:
        with open("/var/log/fail2ban.log", errors="replace") as f:
            lines = f.readlines()[-5000:]
    except OSError:
        return []
    cutoff = time.time() - DAY
    banned = []
    for line in lines:
        m = re.match(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d).*\] Ban (\S+)", line)
        if m and datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").timestamp() >= cutoff:
            banned.append(m.group(2))
    if not banned:
        return []
    return [item(("f2b", datetime.now().date(), bucket(len(banned))), "info",
                 "fail2ban banned {} in the last 24h".format(plural(len(banned), "IP")),
                 ", ".join(sorted(set(banned))[:6]))]


def check_disk():
    u = shutil.disk_usage("/")
    pct = round(u.used * 100 / u.total)
    if pct < 80:
        return []
    level = "crit" if pct >= 90 else "warn"
    return [item(("disk", level), level, "Root disk {}% full".format(pct), "{:.1f} GB free".format(u.free / 1e9))]


def check_services():
    items = []
    for svc in SERVICES:
        out, _ = run(["systemctl", "is-active", svc])
        state = out.strip() or "unknown"
        if state != "active":
            items.append(item(("svc", svc, state, datetime.now().date()), "crit", "{} is {}".format(svc, state),
                              "The public tunnel depends on it." if svc == "cloudflared" else ""))
    return items


CHECKS = (check_services, check_apt, check_reboot, check_ssh, check_fail2ban, check_disk, check_apt_history)

_cache = {"at": 0, "body": b""}
_lock = threading.Lock()


def feed_body():
    with _lock:
        if time.time() - _cache["at"] > CACHE_SECONDS:
            items = []
            for check in CHECKS:
                try:
                    items.extend(check())
                except Exception as e:  # one broken check shouldn't take down the feed
                    items.append(item(("check-error", check.__name__), "warn", "{} failed".format(check.__name__), str(e)))
            items.sort(key=lambda i: -i["ts"])
            data = {"host": socket.gethostname(), "generated": int(time.time()), "items": items}
            _cache.update(at=time.time(), body=json.dumps(data).encode())
        return _cache["body"]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] != "/feed":
            return self.send_error(404)
        expected = "Bearer " + TOKEN
        if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), expected.encode()):
            return self.send_error(401)
        body = feed_body()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # keep the journal quiet; the extension polls every few minutes


if __name__ == "__main__":
    print("secfeed listening on http://{}:{}/feed".format(BIND, PORT), flush=True)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
