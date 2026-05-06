#!/usr/bin/env bash
# Run every quality gate the repo ships. Safe to run without docker
# (real-server tests are skipped unless MYSQL_REAL=1 is set).
#
# Usage:
#   bash scripts/verify.sh

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

echo "==> typecheck (tsc --noEmit)"
bun run typecheck

echo "==> unit + integration tests (bun test)"
bun test

echo "==> TLS handshake tests (node + tsx)"
./node_modules/.bin/tsx --test --test-reporter=spec --test-timeout=15000 tests-node/tls-node-tests.ts

echo "==> build (tsc → dist/)"
rm -rf dist
bun run build
test -f dist/index.js || { echo "dist/index.js missing"; exit 1; }
test -f dist/index.d.ts || { echo "dist/index.d.ts missing"; exit 1; }
echo "dist/ contains $(find dist -type f | wc -l | tr -d ' ') files."

echo
echo "All checks passed."
