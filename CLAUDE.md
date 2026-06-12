# @perryts/mysql

Pure-TypeScript MySQL / MariaDB wire-protocol driver. Sibling of **Tusk**
(the GUI that consumes it) and of **@perryts/postgres** (the other
Perry-showcase driver). Published independently as `@perryts/mysql` and
usable by any Perry or Node.js program that wants to talk to MySQL 8,
MariaDB 11, or compatible servers.

## Positioning

- **Showcase of Perry's systems-programming capability.** No native crate
  in this package; all capabilities come from perry-stdlib
  (`net.Socket`, `tls.connect`, `socket.upgradeToTLS`, `crypto.*`, `Buffer`).
- **Runs unchanged on Node.js / Bun.** The only API surface that differs
  between Perry and Node is TLS upgrade; a one-function adapter handles it.
  Everything else (Buffer, crypto, net.Socket events, little-endian reads)
  is Node-compatible by construction.
- **Shaped for a GUI**, not an ORM. Returns raw rows plus full column
  metadata (type code, flags, collation, lengths, table/org-table,
  name/org-name). Exposes warnings, structured ErrPacket fields, server
  connection id, server version.

## Architecture

```
TypeScript driver
    │
    ├── src/protocol/   3-byte+seq framing, lenenc codecs, writer/reader/decoder (M1, M2)
    ├── src/auth/       mysql_native_password, caching_sha2_password,
    │                   sha256_password, mysql_clear_password, client_ed25519 (M3)
    ├── src/transport/  TCP socket adapter + TLS upgrade                         (M2)
    ├── src/types/      type-code → codec registry                               (M5)
    ├── src/error.ts    structured MyError (errno, sqlState, message)            (M2)
    ├── src/warnings.ts MyWarning (SHOW WARNINGS surface)                        (M7)
    ├── src/cancel.ts   second-connection + KILL QUERY                           (M6)
    ├── src/connection.ts  Connection: lifecycle, text + prepared queries        (M2, M4)
    └── src/index.ts    public barrel exports
```

## Milestones (mirror the plan at /Users/amlug/.claude/plans/akin-to-postgres-we-immutable-knuth.md)

- **M1** — Packet framing, lenenc codecs, buffer-cursor, null-bitmap. Unit tests green.
- **M2** — TCP + HandshakeV10 + HandshakeResponse41 + COM_QUERY (`SELECT 1`).
- **M3** — Auth plugins + auth-switch dispatcher (native, caching_sha2, sha256, clear, ed25519).
- **M4** — Extended (prepared) protocol: COM_STMT_PREPARE/EXECUTE/CLOSE + binary rows + LRU cache.
- **M5** — 20 type codecs (binary + text) + rich wrappers (Decimal, MyDate/MyTime/MyDateTime).
- **M6** — TLS via SSLRequest + sslmode + pool + cancel via KILL QUERY + sql`` template + URL/env.
- **M7** — Multi-resultset, LOCAL_INFILE guard, SHOW WARNINGS auto-fetch, docker matrix green.

## Node.js compatibility contract

Code under `src/` must only use APIs available both in Perry's stdlib and
Node.js core:

- `Buffer` (same API on both), `Buffer.concat`, little-endian read/write.
- `net.createConnection(host, port)` with `.on('connect'|'data'|'error'|'close')`.
- `crypto.createHash / createHmac / publicEncrypt / sign / randomBytes / ...`.

The one divergence is TLS upgrade:

- Perry: `socket.upgradeToTLS(servername, verify)` returns a Promise.
- Node: `tls.connect({ socket, servername, rejectUnauthorized })` returns a new TLSSocket.

`src/transport/upgrade-tls.ts` is a ~15-line adapter that feature-detects
and picks the right path. No other code in the driver needs to know about
the difference.

## Perry AOT constraints (apply to all source files)

Per the hone CLAUDE.md conventions:

- No `?.` optional chaining — use explicit `if (x === undefined)` / `if (x === null)`.
- No `??` nullish coalescing — use explicit branching.
- No `obj[variable]` dynamic key access — use `if/else if` or switch.
- No `/regex/.test()` — use `indexOf` or char-code checks.
- No `{ key }` ES6 shorthand — write `{ key: key }`.
- No `for...of` on arrays — use `for (let i = 0; i < arr.length; i++)`.
- No `setTimeout` self-recursion — use `setInterval`.
- No closures capturing instance methods as `this.method` — store state in
  module-level `Map<id, State>` and use named module-level handlers.
- No `Buffer[i]` bracket indexing — Perry's codegen doesn't lower it, the
  read returns undefined and scans walk off the end. Use `buf.readUInt8(i)`.
- No `socket.write()` from inside a `'data'` handler — Perry on Linux
  silently drops it (no write(2) syscall; PerryTS/perry#5021). All driver
  writes must go through `socketWrite()` in `connection.ts`, which queues
  and flushes from a zero-delay timer under Perry (sync write on Node/Bun).

## MySQL-specific gotchas

- **Little-endian everything.** MySQL is LE; `@perryts/postgres` is BE. Don't
  share `BufferCursor` between the two drivers.
- **3-byte length + 1-byte seq id** per packet, max 16 MB payload. A payload
  of exactly 16 MB triggers a trailing zero-length continuation packet.
  `seq = (seq + 1) & 0xFF` must wrap every 256 packets.
- **0xFE is ambiguous.** (a) EOF packet (≤9-byte payload, old-style), (b)
  AuthSwitchRequest (during auth state), (c) LOCAL_INFILE request (during
  resultset state, payload is a filename). Disambiguate by (state, payload
  length).
- **Binary-row NULL bitmap has a +2 offset.** Only for server→client rows;
  param bitmaps for `COM_STMT_EXECUTE` do not. Two separate helpers.
- **Server speaks first.** HandshakeV10 arrives before the client writes
  anything. State machine is inverted from Postgres.
- **Auth plugins can switch mid-handshake.** The server may reply with an
  `AuthSwitchRequest (0xFE)` asking for a different plugin's response.
  Dispatcher lives in `auth/dispatcher.ts`.
- **`caching_sha2_password` full-auth over plain TCP** needs RSA pubkey
  retrieval. Gate behind `allowPublicKeyRetrieval: boolean` (default false,
  matches JDBC).
- **Empty-password `mysql_native_password`.** The auth response field is
  zero bytes long (NOT 20 zero bytes). Common bug.
- **`?` placeholders**, not `$N`. `sql.ts` doesn't need renumbering.

## Testing

```bash
bun test                    # all tests
bun test tests/unit         # pure unit tests (no DB)
bun test tests/integration  # mock-server + docker-compose matrix
```
