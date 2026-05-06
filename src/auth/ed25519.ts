// MariaDB client_ed25519.
//
// MariaDB signs the server challenge with a 32-byte Ed25519 private key
// derived from the password (MariaDB's "ed25519_password_hash"). For the
// client side, the scheme simplifies to:
//
//   private_key_seed = SHA512(password)[0..32]   // MariaDB's reference impl
//   signature = Ed25519_sign(private_key_seed, challenge)
//
// Node's crypto module can sign with a raw Ed25519 key given as a PEM or
// DER-encoded PKCS8. We construct the PKCS8 DER on the fly from the seed.

import * as crypto from 'node:crypto';
import type { AuthCtx, AuthPlugin } from './dispatcher';

export const CLIENT_ED25519: AuthPlugin = {
    name: 'client_ed25519',
    initialResponse(ctx: AuthCtx): Buffer {
        if (ctx.password.length === 0) {
            return Buffer.alloc(0);
        }
        const seed = sha512(Buffer.from(ctx.password, 'utf8')).subarray(0, 32);
        const pkcs8 = ed25519Pkcs8(seed);
        const key = crypto.createPrivateKey({
            key: pkcs8,
            format: 'der',
            type: 'pkcs8',
        });
        // Ed25519 signing takes `null` as the digest parameter.
        return crypto.sign(null, ctx.challenge, key);
    },
};

/**
 * Wrap a 32-byte Ed25519 seed in a minimal PKCS8 DER envelope so that
 * `crypto.createPrivateKey` accepts it.
 *
 * The DER is a fixed prefix + the 32-byte seed:
 *
 *   30 2e                    -- SEQUENCE (46 bytes)
 *     02 01 00                -- INTEGER version=0
 *     30 05                   -- SEQUENCE AlgorithmIdentifier
 *       06 03 2b 65 70          -- OID 1.3.101.112 (Ed25519)
 *     04 22                   -- OCTET STRING (34 bytes) privateKey
 *       04 20                   -- inner OCTET STRING (32 bytes)
 *         <32-byte seed>
 */
function ed25519Pkcs8(seed: Buffer): Buffer {
    const prefix = Buffer.from([
        0x30, 0x2e,
        0x02, 0x01, 0x00,
        0x30, 0x05,
        0x06, 0x03, 0x2b, 0x65, 0x70,
        0x04, 0x22,
        0x04, 0x20,
    ]);
    return Buffer.concat([prefix, seed]);
}

function sha512(b: Buffer): Buffer {
    const h = crypto.createHash('sha512');
    h.update(b);
    return h.digest();
}
