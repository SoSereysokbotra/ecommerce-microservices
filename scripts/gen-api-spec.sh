#!/usr/bin/env bash
#
# Captures each service's OpenAPI document into openapi/<service>.json.
#
# Requires the stack to be running, because the document is produced by the
# live Nest app. Run this after changing any controller or DTO, and commit the
# result — `npm run gen:types` and the CI staleness check both read these files
# and need no database.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p openapi

declare -A SERVICES=(
  [users]=3001
  [catalog]=3002
  [inventory]=3003
  [orders]=3004
  [payments]=3005
)

failed=0
for name in "${!SERVICES[@]}"; do
  port="${SERVICES[$name]}"
  url="http://localhost:${port}/api/v1/docs-json"

  if ! curl -sf --max-time 10 "$url" -o "openapi/${name}.tmp.json"; then
    echo "  ${name}: FAILED — is the stack running? ($url)"
    rm -f "openapi/${name}.tmp.json"
    failed=1
    continue
  fi

  # Pretty-print with stable key order so the file only changes when the API
  # changes, not on every capture.
  node -e "
    const fs = require('fs');
    const doc = JSON.parse(fs.readFileSync('openapi/${name}.tmp.json', 'utf8'));
    const sort = (v) => Array.isArray(v) ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.keys(v).sort().reduce((o, k) => (o[k] = sort(v[k]), o), {})
        : v;
    fs.writeFileSync('openapi/${name}.json', JSON.stringify(sort(doc), null, 2) + '\n');
  "
  rm -f "openapi/${name}.tmp.json"
  echo "  ${name}: openapi/${name}.json"
done

exit "$failed"
