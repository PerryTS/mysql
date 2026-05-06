#!/usr/bin/env bash
# Bring up docker MySQL 8 + MariaDB 11, run the real-server integration
# suite against each, tear down.
#
# Requires docker.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="$DIR/tests/integration/docker-compose.yml"

if ! command -v docker >/dev/null 2>&1; then
    echo "docker not found — skipping real-server tests." >&2
    exit 0
fi

echo ">>> Bringing up MySQL 8 + MariaDB 11..."
docker compose -f "$COMPOSE" up -d

cleanup() {
    echo ">>> Tearing down..."
    docker compose -f "$COMPOSE" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo ">>> Waiting for MySQL 8 to be healthy..."
for i in {1..60}; do
    if docker exec perry-mysql8 mysqladmin -h 127.0.0.1 -uroot -prootpw ping >/dev/null 2>&1; then
        echo "MySQL 8 ready."
        break
    fi
    sleep 1
done

echo ">>> Running tests against MySQL 8 (port 33306)..."
MYSQL_REAL=1 \
MYSQL_HOST=127.0.0.1 \
MYSQL_TCP_PORT=33306 \
MYSQL_USER=root \
MYSQL_PASSWORD=rootpw \
MYSQL_DATABASE=perry_test \
bun test tests/integration/real-server.test.ts

echo ">>> Waiting for MariaDB 11 to be healthy..."
for i in {1..60}; do
    if docker exec perry-mariadb11 mariadb-admin -h 127.0.0.1 -uroot -prootpw ping >/dev/null 2>&1; then
        echo "MariaDB 11 ready."
        break
    fi
    sleep 1
done

echo ">>> Running tests against MariaDB 11 (port 33307)..."
MYSQL_REAL=1 \
MYSQL_HOST=127.0.0.1 \
MYSQL_TCP_PORT=33307 \
MYSQL_USER=root \
MYSQL_PASSWORD=rootpw \
MYSQL_DATABASE=perry_test \
bun test tests/integration/real-server.test.ts

echo ">>> All real-server tests passed."
