#!/usr/bin/env bash
#
# Fails if a COMMITTED file contains what looks like a real credential.
#
# Why this exists: the previous project committed a live Neon database password
# inside five .env.example files, in a public repository.
#
# Scope: only files git tracks. A real credential in apps/<service>/.env is
# correct and expected — that file is gitignored and never leaves the machine.
# Scanning the working tree instead of the index would flag it and train people
# to ignore this check.
#
# The rule is host-based rather than password-based. A connection string
# pointing at a Docker service name (`rabbitmq`, `redis`) or at localhost is a
# local development placeholder and is fine. One pointing at a routable host —
# anything containing a dot, such as *.neon.tech — is a real credential.
#
# Documentation placeholders are excluded: a credential containing '<', '$' or
# '{' is a template such as <user>:<password>@<endpoint>.neon.tech, not a leak.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

status=0

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not a git repository — nothing is committed yet, so nothing to scan."
  exit 0
fi

# Only tracked files, excluding lockfiles which are noisy and never hold secrets.
mapfile -t FILES < <(git ls-files | grep -vE '(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$')

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "No tracked files to scan."
  exit 0
fi

echo "==> Scanning ${#FILES[@]} tracked files for credentials aimed at remote hosts"
remote_creds=$(grep -InE \
  '(postgres(ql)?|amqp|redis|mongodb(\+srv)?|mysql)://[^:/@[:space:]]+:[^@[:space:]]+@[^/[:space:]"]*\.[^/[:space:]"]*' \
  "${FILES[@]}" 2>/dev/null \
  | grep -vE '@(localhost|127\.0\.0\.1)' \
  | grep -vE '[<${]')

if [ -n "$remote_creds" ]; then
  echo "ERROR: credential pointing at a remote host found in a committed file:"
  echo "$remote_creds" | sed -E 's/:[^:@]+@/:***@/g'
  echo "Use a placeholder. If this was ever pushed, rotate the credential now."
  status=1
fi

echo "==> Scanning for known provider secret prefixes"
prefixes=$(grep -InE '(npg_[A-Za-z0-9]{8,}|sk_live_[A-Za-z0-9]{8,}|sk_test_[A-Za-z0-9]{8,}|rk_live_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})' \
  "${FILES[@]}" 2>/dev/null | grep -vE '[<${]')

if [ -n "$prefixes" ]; then
  echo "ERROR: a provider secret token was found:"
  echo "$prefixes" | sed -E 's/(npg_|sk_live_|sk_test_|gh[pousr]_|AKIA|xox[baprs]-)[A-Za-z0-9_-]+/\1***/g'
  status=1
fi

echo "==> Checking that no .env file is tracked"
tracked_env=$(git ls-files | grep -E '(^|/)\.env$|(^|/)\.env\.(local|development|production|test)' || true)
if [ -n "$tracked_env" ]; then
  echo "ERROR: a .env file is tracked. Only .env.example may be committed:"
  echo "$tracked_env"
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo
  echo "PASS: no credentials found in committed files."
fi

exit "$status"
