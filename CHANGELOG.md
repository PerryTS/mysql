# Changelog

## v0.1 — initial release

Milestones M1 → M7, all shipped:

- **M1 — Framing + low-level codecs.** 3-byte length + 1-byte seq id packet
  framing, >16 MB continuation handling, length-encoded integer + string
  codecs, little-endian buffer cursor, NULL-bitmap helpers (with the
  server→client +2 reserved-bit offset baked in).
- **M2 — Handshake + text query.** `HandshakeV10` decoding,
  `HandshakeResponse41` building, `COM_QUERY` / `COM_QUIT` / `COM_PING`,
  structured `MyError` (errno + SQLSTATE + message), cross-runtime
  socket adapter (Node, Bun, Perry).
- **M3 — Auth plugins.** Dispatcher handling `AuthSwitchRequest` and
  `AuthMoreData` mid-handshake. Built-in plugins:
  `mysql_native_password`, `caching_sha2_password` (with RSA-OAEP-SHA1
  public-key retrieval, gated by `allowPublicKeyRetrieval`),
  `sha256_password`, `mysql_clear_password` (TLS-gated), MariaDB
  `client_ed25519`. Custom plugins pluggable via `registerAuthPlugin`.
- **M4 — Prepared protocol.** `COM_STMT_PREPARE` / `COM_STMT_EXECUTE` /
  `COM_STMT_CLOSE` / `COM_STMT_RESET` / `COM_STMT_SEND_LONG_DATA`.
  Per-connection prepared-statement cache keyed on SQL text.
  Binary-resultset decoder with the +2 server→client NULL-bitmap offset.
- **M5 — Type codec registry + 23 codecs.** Parallel-array registry
  keyed on MYSQL_TYPE_* + column flags. Built-in codecs for TINY,
  SHORT, LONG, LONGLONG, INT24, FLOAT, DOUBLE, NEWDECIMAL (+ legacy
  DECIMAL), NULL, YEAR, BIT, VAR_STRING, STRING, VARCHAR, BLOB (+ TINY,
  MEDIUM, LONG), ENUM, SET, GEOMETRY, JSON, DATE, DATETIME, TIMESTAMP,
  TIME. `Decimal` wrapper (string-backed, lossless). `MyDate`,
  `MyDateTime`, `MyTime` wrappers preserving microsecond precision.
  Callers can override codecs via `registerType()`.
- **M6 — TLS, pool, cancel, sql tag, URL/env resolution.**
  `SSLRequest` + mid-stream TLS upgrade (`sslmode`:
  `disable` / `require` / `verify-ca` / `verify-full`) with a single
  Perry-vs-Node adapter. `Pool` with idle / acquire timeouts and a
  `withConnection` / `transaction` surface. `Connection.cancel()` opens
  a second connection and runs `KILL QUERY <connection_id>`.
  `sql\`\`` tagged template with `?` placeholders and `raw()` for
  identifiers. `parseConnectionString` for `mysql://` / `mariadb://`
  DSNs with `ssl-mode`, `charset`, `allowPublicKeyRetrieval` query
  params. `resolveConnectOptions` for libmysqlclient-style env
  precedence (`MYSQL_HOST`, `MYSQL_TCP_PORT`, `MYSQL_USER`, `MYSQL_PWD`,
  `MYSQL_DATABASE`, `MYSQL_SSL_MODE`).
- **M7 — Multi-resultset, LOCAL_INFILE guard, polish.**
  Multi-statement / multi-resultset handling gated on
  `multipleStatements: true`; each set surfaces on
  `QueryResult.resultSets`. `LOCAL INFILE` requests default to a clean
  `MyError` refusal with the requested filename in the message.
  Benchmark harness + shared workloads against `mysql2` / `mysql`.
  Additional smoke examples (`perry-smoke-prepared`, `perry-smoke-tls`,
  `select-one`).

### Polish after M7

- **Positive-path TLS integration tests.** `tests-node/tls-node-tests.ts`
  drives full `SSLRequest` → TLS handshake → `HandshakeResponse41`
  round-trips against an in-process mock server with a throwaway
  self-signed cert. Runs under `node --import tsx --test` (Bun 1.3's
  `tls.connect({socket})` stalls; negative paths still covered under
  `bun test`).
- **Cancel integration test.** Mock server supports `simulatedSleepMs`
  + `KILL QUERY <id>` relay between connections; verifies
  `conn.cancel()` returns errno 1317 / SQLSTATE 70100 on the target.
- **Bench harness vs mysql2 and legacy mysql.** `bench/bench-mysql2.ts`
  and `bench/bench-mysql.ts` mirror `bench-this.ts`; `bench/package.json`
  keeps comparison drivers out of the main package.
- **Docker real-server matrix.** `scripts/test-real.sh` brings up MySQL 8
  + MariaDB 11 via `docker-compose.yml`, runs
  `tests/integration/real-server.test.ts` against both (skipped by
  default without `MYSQL_REAL=1`).
- **Warning event hook.** `conn.on('warning', cb)` fires a summary
  `MyWarning` whenever a query returns `warningCount > 0`.
- **`scripts/verify.sh`** — one-shot gate: typecheck → bun test → node
  TLS → build.

### Bug fixes found via real-server testing (MySQL 8.0.45)

- **HandshakeResponse41 caps mismatch over TLS.** The SSLRequest
  advertised `CLIENT_CONNECT_ATTRS` while `HandshakeResponse41` (built
  after the upgrade) stripped it when no attrs were supplied. MySQL
  cross-checks the two and rejected with errno 1043 "Bad handshake".
  Now both frames are computed from a single `initialCaps` up front,
  guaranteeing exact equality.
- **Prepared INSERT/UPDATE/DELETE hung.** `COM_STMT_EXECUTE` responses
  for statements that return no resultset are a single OK packet, but
  the driver jumped straight to the row-collection phase and tried to
  decode the OK as a binary row. Fixed by always entering the exec
  response through the column-count phase — its first-packet branch
  correctly recognises the OK.
- **`Buffer.isBuffer()` not lowered by Perry AOT codegen.** Replaced
  with a duck-type check (`typeof v.readUInt8 === 'function' &&
  typeof v.length === 'number'`) so the driver source compiles cleanly
  under `perry compile`.

### Perry AOT status

- `perry check --check-deps examples/perry-aot-smoke.ts` passes.
- `perry compile examples/perry-aot-smoke.ts` produces a 3.6 MB arm64
  Mach-O binary.
- **Full end-to-end connect + text query + prepared query + close runs
  natively** against a real MySQL 8.0.45 server with the driver source
  identical across all three runtimes (Node, Bun, Perry AOT). Confirmed
  on perry 0.5.99.
- Bringing the AOT target up surfaced eight Perry compiler issues —
  #78, #79, #80, #81, #82 (fixed in 0.5.95); #85 (fixed in 0.5.97); #87,
  #88 (fixed in 0.5.98); #91 (fixed in 0.5.99). All driver-side
  workarounds were removed once the upstream fixes landed.
- The one driver fix that stuck (and would have been correct against
  every Node/Bun version too) was switching `raw[raw.length - 1]` to
  `raw.readUInt8(raw.length - 1)` in `decoder.decodeHandshakeV10` —
  Perry-stdlib's Buffer doesn't lower bracket indexing, and the
  spurious truthiness left a stray NUL in the auth challenge that
  silently corrupted the SCRAM scramble.
