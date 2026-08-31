#!/usr/bin/env bash
#
# Generates TypeScript types from the committed OpenAPI documents.
#
# Pure: reads openapi/*.json and writes libs/api-types/src/*.d.ts. No database,
# no running services — which is what lets CI verify the output is current.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p libs/api-types/src

shopt -s nullglob
specs=(openapi/*.json)
if [ ${#specs[@]} -eq 0 ]; then
  echo "No specs in openapi/. Run 'npm run gen:spec' with the stack up first."
  exit 1
fi

for spec in "${specs[@]}"; do
  name="$(basename "$spec" .json)"
  npx --yes openapi-typescript@7 "$spec" -o "libs/api-types/src/${name}.d.ts" >/dev/null
  echo "  ${name}: libs/api-types/src/${name}.d.ts"
done
