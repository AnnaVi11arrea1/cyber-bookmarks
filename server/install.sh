#!/usr/bin/env bash
# Install the NEURAL//LINKS security feed on the Jetson.
#   scp -r server/ <you>@<jetson>:~/secfeed && ssh <you>@<jetson> 'sudo bash ~/secfeed/install.sh'
# Re-running is safe: it keeps the existing token and just updates the script.
set -euo pipefail
cd "$(dirname "$0")"

id secfeed &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin secfeed
install -d /opt/secfeed
install -m 755 secfeed.py /opt/secfeed/secfeed.py

if [[ ! -f /etc/secfeed.env ]]; then
  # The default route's source address is the LAN IP (skips docker/tailscale bridges).
  LAN_IP=$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
  TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
  printf 'SECFEED_TOKEN=%s\nSECFEED_BIND=%s\nSECFEED_PORT=8890\nSECFEED_SERVICES=cloudflared\n' "$TOKEN" "$LAN_IP" > /etc/secfeed.env
  chown root:secfeed /etc/secfeed.env
  chmod 640 /etc/secfeed.env
fi

install -m 644 secfeed.service /etc/systemd/system/secfeed.service
systemctl daemon-reload
systemctl enable secfeed
systemctl restart secfeed

# shellcheck disable=SC1091
. /etc/secfeed.env

if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
  # Allow only the subnet the bind address lives on (e.g. 192.168.1.50/24 -> 192.168.1.0/24).
  LAN_CIDR=$(ip -4 -o addr show | awk -v ip="$SECFEED_BIND" '{split($4, a, "/"); if (a[1] == ip) print $4}' | head -n1)
  if [[ -n "$LAN_CIDR" ]]; then
    SUBNET=$(python3 -c 'import ipaddress, sys; print(ipaddress.ip_interface(sys.argv[1]).network)' "$LAN_CIDR")
    ufw allow from "$SUBNET" to any port "$SECFEED_PORT" proto tcp comment 'secfeed (LAN only)'
  else
    echo "warning: no interface has ${SECFEED_BIND}; add a ufw rule for port ${SECFEED_PORT} yourself" >&2
  fi
fi

echo
echo "Paste these into the extension (SIGNAL FEED > gear icon):"
echo "  Jetson feed URL:   http://${SECFEED_BIND}:${SECFEED_PORT}/feed"
echo "  Jetson feed token: ${SECFEED_TOKEN}"
