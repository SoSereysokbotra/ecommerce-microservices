#!/usr/bin/env bash
#
# Publish the local stack on two public HTTPS URLs via Cloudflare Tunnel.
#
# Quick tunnels mint a NEW random hostname every run, and three things depend on
# that hostname: the storefront bundle (NEXT_PUBLIC_* is inlined at build time),
# the gateway's CORS allowlist, and the Stripe webhook endpoint. So this is not
# "start a tunnel" — it is a re-wire, and it must happen in this order.
#
#   gateway tunnel -> storefront build -> storefront tunnel -> CORS -> Stripe
#
# Usage:  bash scripts/tunnel-up.sh
# Stop:   bash scripts/tunnel-down.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
RUN="$ROOT/.tunnel"
TOOLS="$ROOT/.tools"
mkdir -p "$RUN" "$TOOLS"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- prerequisites
if ! curl -sf -m 10 http://127.0.0.1:3000/api/v1/health >/dev/null; then
  echo "The gateway is not answering on 127.0.0.1:3000."
  echo "Start the stack first:  docker compose up -d"
  echo "If Redis fails to bind, stop the conflicting container:  docker stop jobfit-redis"
  exit 1
fi

CF="$TOOLS/cloudflared.exe"
if command -v cloudflared >/dev/null 2>&1; then
  CF="$(command -v cloudflared)"
fi
# A ~50MB transfer does fail occasionally, and a truncated binary is not
# runnable, so retry the download and then sanity-check the size.
if [ ! -s "$CF" ]; then
  log "Downloading cloudflared"
  curl -fL --retry 3 --retry-delay 2 --max-time 600 -o "$TOOLS/cloudflared.exe" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
  CF="$TOOLS/cloudflared.exe"
  if [ "$(wc -c <"$CF")" -lt 10000000 ]; then
    echo "cloudflared download looks truncated; delete .tools/ and retry." >&2
    exit 1
  fi
fi

# Read a value from a .env file, tolerating the single quotes those files use.
env_value() { grep "^$2=" "$1" | cut -d= -f2- | tr -d "'\"" | tr -d '\r'; }

# Start a quick tunnel and echo the hostname it is given.
start_tunnel() {
  local port="$1" name="$2" logfile="$RUN/$2.log" url=""
  "$CF" tunnel --url "http://127.0.0.1:$port" --no-autoupdate >"$logfile" 2>&1 &
  echo $! >"$RUN/$name.pid"
  for _ in $(seq 1 60); do
    url="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$logfile" 2>/dev/null | head -1 || true)"
    [ -n "$url" ] && break
    sleep 1
  done
  [ -z "$url" ] && { echo "no URL from cloudflared for $name; see $logfile" >&2; exit 1; }
  echo "$url"
}

# ------------------------------------------------------------------- 1. gateway
log "Tunnelling the gateway (:3000)"
GW="$(start_tunnel 3000 gateway)"
echo "$GW" >"$RUN/gateway.url"
echo "    $GW"

# --------------------------------------------------------------- 2. storefront
# NEXT_PUBLIC_API_URL is compiled into the browser bundle, so the gateway URL
# has to exist before this build — it cannot be changed by a restart afterwards.
log "Building the storefront against $GW/api/v1"
PK="$(env_value storefront/.env.local NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)"
docker build --target production -t commerce-storefront:tunnel \
  --build-arg "NEXT_PUBLIC_API_URL=$GW/api/v1" \
  --build-arg "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$PK" \
  storefront >"$RUN/storefront-build.log" 2>&1

docker rm -f commerce-storefront >/dev/null 2>&1 || true
docker run -d --name commerce-storefront --restart unless-stopped \
  -e PORT=3100 -p 3100:3100 commerce-storefront:tunnel >/dev/null

for _ in $(seq 1 60); do
  curl -sf -m 5 http://127.0.0.1:3100/ >/dev/null && break
  sleep 2
done

log "Tunnelling the storefront (:3100)"
SF="$(start_tunnel 3100 storefront)"
echo "$SF" >"$RUN/storefront.url"
echo "    $SF"

# --------------------------------------------------------------------- 3. CORS
# The browser loads the page from SF and calls the API on GW: cross-origin.
# Without this the browser blocks every response, whatever the server returns.
log "Allowing $SF as a browser origin"
if grep -q '^CORS_ORIGINS=' apps/api-gateway/.env; then
  sed -i "s#^CORS_ORIGINS=.*#CORS_ORIGINS=$SF#" apps/api-gateway/.env
else
  printf '\nCORS_ORIGINS=%s\n' "$SF" >>apps/api-gateway/.env
fi
# force-recreate, not restart: a plain restart does not reload env_file.
docker compose up -d --force-recreate api-gateway >/dev/null 2>&1

# ------------------------------------------------------------------- 4. Stripe
# Register the new hostname and adopt its signing secret. Endpoints from earlier
# runs point at dead hostnames, so they are removed rather than left to pile up.
log "Registering the Stripe webhook endpoint"
SK="$(env_value apps/payments-service/.env STRIPE_SECRET_KEY)"
case "$SK" in
  sk_test_*) ;;
  *) echo "STRIPE_SECRET_KEY is not a test-mode key; refusing to continue." >&2; exit 1 ;;
esac

WH_URL="$GW/api/v1/payments/webhook"
python - "$SK" "$WH_URL" <<'PY'
import json, subprocess, sys, urllib.parse, urllib.request

sk, url = sys.argv[1], sys.argv[2]

def api(path, data=None, method=None):
    req = urllib.request.Request(
        "https://api.stripe.com/v1/" + path,
        data=urllib.parse.urlencode(data, doseq=True).encode() if data else None,
        method=method,
    )
    import base64
    req.add_header("Authorization", "Basic " + base64.b64encode(f"{sk}:".encode()).decode())
    with urllib.request.urlopen(req) as r:
        return json.load(r)

for ep in api("webhook_endpoints?limit=100").get("data", []):
    if "trycloudflare.com" in ep.get("url", "") and ep["url"] != url:
        api(f"webhook_endpoints/{ep['id']}", method="DELETE")
        print(f"    removed stale endpoint {ep['id']}")

created = api("webhook_endpoints", {
    "url": url,
    "enabled_events[]": ["payment_intent.succeeded", "payment_intent.payment_failed"],
    "description": "Cloudflare Tunnel (test mode)",
})
open(".tunnel/whsec", "w").write(created["secret"])
print(f"    endpoint {created['id']} -> {created['status']}")
PY

WHSEC="$(cat "$RUN/whsec")"
if grep -q '^STRIPE_WEBHOOK_SECRET=' apps/payments-service/.env; then
  sed -i "s#^STRIPE_WEBHOOK_SECRET=.*#STRIPE_WEBHOOK_SECRET=$WHSEC#" apps/payments-service/.env
else
  printf '\nSTRIPE_WEBHOOK_SECRET=%s\n' "$WHSEC" >>apps/payments-service/.env
fi
rm -f "$RUN/whsec"
docker compose up -d --force-recreate payments-service >/dev/null 2>&1

# ------------------------------------------------------------------------ done
cat <<EOF

  Storefront   $SF
  API          $GW/api/v1
  Swagger      $GW/api/v1/docs
  Webhook      $WH_URL

  Both URLs live only while this machine and these tunnels are running.
  Stop with: bash scripts/tunnel-down.sh
EOF
