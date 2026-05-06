#!/usr/bin/env bash
# Run every benchmark harness against the same server, print a consolidated
# comparison. Assumes a running MySQL 8 / MariaDB 11 on MYSQL_HOST:MYSQL_TCP_PORT.
#
# Setup:
#   docker compose -f ../tests/integration/docker-compose.yml up -d
#   (cd bench && bun install)  # installs mysql2 / mysql into bench/node_modules
#
# Then:
#   MYSQL_HOST=127.0.0.1 MYSQL_TCP_PORT=33306 \
#   MYSQL_USER=root MYSQL_PASSWORD=rootpw MYSQL_DATABASE=perry_test \
#   bash bench/run-all.sh

set -euo pipefail

echo "=== @perryts/mysql ==="
bun bench/bench-this.ts
echo
echo "=== mysql2 ==="
bun bench/bench-mysql2.ts
echo
echo "=== mysql (legacy) ==="
bun bench/bench-mysql.ts
