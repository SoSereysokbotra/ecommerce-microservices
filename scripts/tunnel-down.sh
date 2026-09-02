#!/usr/bin/env bash
#
# Take down the public tunnels and the storefront container.
#
# The backend stack is left running: `docker compose down` is a separate,
# deliberate act. Removing the Stripe endpoint matters — its hostname dies with
# the tunnel, and a dead endpoint accumulates failed deliveries in the dashboard.
set -uo pipefail

cd "$(dirname "$0")/.."
RUN="$(pwd)/.tunnel"

for name in gateway storefront; do
  if [ -f "$RUN/$name.pid" ]; then
    pid="$(cat "$RUN/$name.pid")"
    kill "$pid" 2>/dev/null && echo "stopped $name tunnel (pid $pid)"
    rm -f "$RUN/$name.pid"
  fi
done
# Quick tunnels sometimes outlive their shell wrapper on Windows.
taskkill //IM cloudflared.exe //F >/dev/null 2>&1 && echo "cleaned up stray cloudflared processes"

docker rm -f commerce-storefront >/dev/null 2>&1 && echo "removed storefront container"

SK="$(grep '^STRIPE_SECRET_KEY=' apps/payments-service/.env | cut -d= -f2- | tr -d "'\"" | tr -d '\r')"
if [ -n "${SK:-}" ]; then
  python - "$SK" <<'PY'
import base64, json, sys, urllib.request

sk = sys.argv[1]

def api(path, method=None):
    req = urllib.request.Request("https://api.stripe.com/v1/" + path, method=method)
    req.add_header("Authorization", "Basic " + base64.b64encode(f"{sk}:".encode()).decode())
    with urllib.request.urlopen(req) as r:
        return json.load(r)

try:
    for ep in api("webhook_endpoints?limit=100").get("data", []):
        if "trycloudflare.com" in ep.get("url", ""):
            api(f"webhook_endpoints/{ep['id']}", method="DELETE")
            print(f"removed Stripe endpoint {ep['id']}")
except Exception as exc:  # offline, rolled key — not worth failing the teardown
    print(f"could not reach Stripe to clean up endpoints: {exc}")
PY
fi

rm -f "$RUN/gateway.url" "$RUN/storefront.url"
echo "done — backend stack still running (docker compose down to stop it)"
