// mysql_native_password.
//
// Challenge/response using SHA-1:
//
//   token = SHA1(password) XOR SHA1( challenge ++ SHA1( SHA1(password) ) )
//
// The 20-byte token is returned as the auth_response. If the password
// is empty we MUST send zero bytes, not 20 zeros — several drivers have
// gotten this wrong.
//
// See MySQL src/sql/auth/sha2_password_common.cc for the reference.

import * as crypto from 'node:crypto';
import type { AuthCtx, AuthPlugin } from './dispatcher';

/** Named plugin singleton — registered by `registerDefaultPlugins`. */
export const NATIVE_PASSWORD: AuthPlugin = {
    name: 'mysql_native_password',
    initialResponse(ctx: AuthCtx): Buffer {
        if (ctx.password.length === 0) {
            return Buffer.alloc(0);
        }
        return nativeScramble(ctx.password, ctx.challenge);
    },
};

/** Exposed for tests: `SHA1(pw) XOR SHA1(challenge ++ SHA1(SHA1(pw)))`. */
export function nativeScramble(password: string, challenge: Buffer): Buffer {
    const sha1Pw = sha1(Buffer.from(password, 'utf8'));
    const sha1Sha1Pw = sha1(sha1Pw);
    // MySQL only uses the first 20 bytes of the challenge (the
    // `auth_plugin_data` field), in case extra bytes slipped in.
    const ch = challenge.length > 20 ? challenge.subarray(0, 20) : challenge;
    const inner = sha1(Buffer.concat([ch, sha1Sha1Pw]));
    const out = Buffer.alloc(sha1Pw.length);
    for (let i = 0; i < sha1Pw.length; i++) {
        out.writeUInt8(sha1Pw.readUInt8(i) ^ inner.readUInt8(i), i);
    }
    return out;
}

function sha1(b: Buffer): Buffer {
    const h = crypto.createHash('sha1');
    h.update(b);
    return h.digest();
}
