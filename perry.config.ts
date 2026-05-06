/**
 * Perry compiler configuration for @perryts/mysql.
 *
 * Pure-TypeScript MySQL/MariaDB wire-protocol driver. No native Rust crate,
 * no FFI declarations — all capabilities come from perry-stdlib
 * (`net.Socket`, `tls.connect`, `socket.upgradeToTLS`, `crypto.*`, `Buffer`).
 */
export default {
  name: '@perryts/mysql',
  version: '0.1.0',
  entry: 'src/index.ts',
  perry: '0.5.20',
};
