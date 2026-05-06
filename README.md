# @perryts/mysql

Pure-TypeScript MySQL / MariaDB wire-protocol driver. Runs on Node.js and
Bun, and ahead-of-time compiles to a native binary via
[Perry](https://github.com/perryts/perry) (LLVM). Zero native dependencies.

Sibling package of
[@perryts/postgres](https://github.com/perryts/postgres).

## Status

v0.1 — **all milestones shipped**:

- [x] M1: Packet framing (3-byte length + seq id, >16 MB chains) + lenenc codecs
- [x] M2: HandshakeV10 + HandshakeResponse41 + `COM_QUERY`
- [x] M3: Auth plugins (`mysql_native_password`, `caching_sha2_password`,
        `sha256_password`, `mysql_clear_password`, MariaDB `client_ed25519`)
        + mid-handshake auth-switch
- [x] M4: Prepared protocol: `COM_STMT_PREPARE` / `EXECUTE` / `CLOSE` +
        per-connection prepared cache + binary-resultset decoder
- [x] M5: Rich type codecs — `Decimal`, `MyDate` / `MyTime` / `MyDateTime`,
        23 built-ins + `registerType()` extension point
- [x] M6: TLS (`SSLRequest` + `sslmode`), `Pool`, `Connection.cancel()`
        via `KILL QUERY`, `sql\`\`` template, `parseConnectionString`,
        `resolveConnectOptions`
- [x] M7: Multi-resultset (`resultSets` on `QueryResult`), LOCAL_INFILE
        refusal by default, benchmark harness, smoke examples

## Quickstart

```ts
import { connect } from '@perryts/mysql';

const conn = await connect({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: 'secret',
    database: 'test',
});

const result = await conn.query('SELECT ? + ? AS sum', [40, 2]);
console.log(result.rows); // [ { sum: 42 } ]

await conn.close();
```

## Testing

```sh
bun run verify       # typecheck + bun test + node TLS tests + build
bun test             # 135 unit + integration tests against mock server
bun run test:tls:node  # TLS mid-stream upgrade under Node (Bun stalls on tls.connect({socket}))
bun run test:real    # docker MySQL 8 + MariaDB 11 integration matrix
```

## Benchmarks

```sh
(cd bench && bun install)  # pulls mysql2 / mysql into bench/node_modules only
MYSQL_HOST=127.0.0.1 MYSQL_TCP_PORT=33306 MYSQL_USER=... \
  bash bench/run-all.sh    # runs @perryts/mysql, mysql2, mysql legacy side by side
```

## Design notes

- No `pg`-style OIDs: MySQL identifies types via a single `MYSQL_TYPE_*`
  byte + a 2-byte flag field. Codecs key on those.
- Binary protocol for parameterised queries, text protocol for parameter-less.
- Rows returned as `{ fields, rows, rowsArray, rowsRaw, command, rowCount }`
  (raw bytes for GUI consumers + decoded objects for ergonomics).
- Zero dependencies at runtime. `mysql2` / `mysql` are dev-only (bench only).

## License

MIT.
