#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Root env
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env"
fi

# Per-service env
for service in api-gateway users-service catalog-service inventory-service; do
  if [ ! -f "apps/$service/.env" ]; then
    cp "apps/$service/.env.example" "apps/$service/.env"
    echo "Created apps/$service/.env"
  fi
done

# A shared secret so the gateway and services agree on token signatures.
if ! grep -q '^JWT_SECRET=.\+' .env; then
  SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  for f in .env apps/api-gateway/.env apps/users-service/.env apps/catalog-service/.env apps/inventory-service/.env; do
    if [ -f "$f" ]; then
      sed -i.bak "s|^JWT_SECRET=.*|JWT_SECRET=${SECRET}|" "$f" && rm -f "$f.bak"
    fi
  done
  echo "Generated a shared JWT_SECRET"
fi

npm install
npm install --prefix libs/common
npm install --prefix libs/rabbitmq
npm install --prefix apps/api-gateway
npm install --prefix apps/users-service
npm install --prefix apps/catalog-service
npm install --prefix apps/inventory-service

# Neon connection strings cannot be generated; they must be pasted in.
missing_db=0
for service in users-service catalog-service inventory-service; do
  if ! grep -q '^DATABASE_URL=.\+' "apps/$service/.env" 2>/dev/null; then
    echo "  ! apps/$service/.env has no DATABASE_URL"
    missing_db=1
  fi
done

echo
if [ "$missing_db" -eq 1 ]; then
  echo "Setup incomplete. Create the databases at https://console.neon.tech,"
  echo "then paste each connection string into the matching apps/<service>/.env."
  echo "Never put a real credential in .env.example."
  echo
  echo "Then:  docker compose up -d"
  exit 1
fi

echo "Setup complete. Next:  docker compose up -d"
