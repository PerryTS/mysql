// caching_sha2_password (MySQL 8 default).
//
// Three-phase protocol:
//
//   1. Initial response: SHA256(pw) XOR SHA256(challenge ++ SHA256(SHA256(pw))).
//      32 bytes. The server either recognises a cached credential (fast
//      auth) or triggers full auth.
//
//   2. Server sends AuthMoreData { marker: byte, ... }:
//        0x03 → FAST_AUTH_SUCCESS. Wait for OK.
//        0x04 → PERFORM_FULL_AUTH.
//                - If TLS is active: send password ++ NUL as plaintext.
//                - Else, if `allowPublicKeyRetrieval`:
//                     client sends 0x02 (REQUEST_PUBLIC_KEY);
//                     server replies AuthMoreData { pem_pubkey };
//                     client XOR-scrambles password+NUL with the challenge,
//                     RSA-OAEP-SHA1 encrypts with the pubkey, sends result.
//                - Else: fail; require TLS or explicit key retrieval.
//
//   3. Server sends OK (or ERR).

import * as crypto from 'node:crypto';
import type { AuthCtx, AuthPlugin, AuthStep } from './dispatcher';
import { xorScramblePassword, rsaOaepEncrypt } from './rsa';
import {
    CACHING_SHA2_FAST_AUTH_SUCCESS,
    CACHING_SHA2_PERFORM_FULL_AUTH,
    CACHING_SHA2_REQUEST_PUBLIC_KEY,
} from '../protocol/messages';

const SCRATCH_PHASE = 'caching_sha2.phase';

type Phase = 'awaiting-status' | 'awaiting-pubkey' | 'done';

export const CACHING_SHA2_PASSWORD: AuthPlugin = {
    name: 'caching_sha2_password',
    initialResponse(ctx: AuthCtx): Buffer {
        ctx.scratch.set(SCRATCH_PHASE, 'awaiting-status');
        if (ctx.password.length === 0) {
            return Buffer.alloc(0);
        }
        return sha256Scramble(ctx.password, ctx.challenge);
    },
    onAuthMoreData(ctx: AuthCtx, payload: Buffer): AuthStep {
        const phase = ctx.scratch.get(SCRATCH_PHASE) as Phase | undefined;
        if (phase === 'awaiting-status') {
            if (payload.length === 0) {
                return { kind: 'fail', reason: 'empty AuthMoreData in caching_sha2' };
            }
            const marker = payload.readUInt8(0);
            if (marker === CACHING_SHA2_FAST_AUTH_SUCCESS) {
                ctx.scratch.set(SCRATCH_PHASE, 'done');
                return { kind: 'ok' };
            }
            if (marker === CACHING_SHA2_PERFORM_FULL_AUTH) {
                if (ctx.tlsActive) {
                    // Send cleartext password + NUL terminator.
                    const out = Buffer.alloc(ctx.password.length + 1);
                    out.write(ctx.password, 0, 'utf8');
                    out.writeUInt8(0, ctx.password.length);
                    ctx.scratch.set(SCRATCH_PHASE, 'done');
                    return { kind: 'write', bytes: out };
                }
                if (!ctx.allowPublicKeyRetrieval) {
                    return {
                        kind: 'fail',
                        reason: 'caching_sha2_password full-auth requires TLS or allowPublicKeyRetrieval=true',
                    };
                }
                ctx.scratch.set(SCRATCH_PHASE, 'awaiting-pubkey');
                return { kind: 'write', bytes: Buffer.from([CACHING_SHA2_REQUEST_PUBLIC_KEY]) };
            }
            return { kind: 'fail', reason: 'unknown caching_sha2 marker 0x' + marker.toString(16) };
        }
        if (phase === 'awaiting-pubkey') {
            // Payload is the PEM-encoded public key.
            const scrambled = xorScramblePassword(ctx.password, ctx.challenge);
            const encrypted = rsaOaepEncrypt(Buffer.from(payload), scrambled);
            ctx.scratch.set(SCRATCH_PHASE, 'done');
            return { kind: 'write', bytes: encrypted };
        }
        return { kind: 'fail', reason: 'unexpected AuthMoreData (phase=' + String(phase) + ')' };
    },
};

/** SHA256(pw) XOR SHA256( SHA256(SHA256(pw)) ++ challenge ). 32-byte output. */
export function sha256Scramble(password: string, challenge: Buffer): Buffer {
    const sha256Pw = sha256(Buffer.from(password, 'utf8'));
    const sha256Sha256Pw = sha256(sha256Pw);
    const ch = challenge.length > 20 ? challenge.subarray(0, 20) : challenge;
    const inner = sha256(Buffer.concat([sha256Sha256Pw, ch]));
    const out = Buffer.alloc(sha256Pw.length);
    for (let i = 0; i < sha256Pw.length; i++) {
        out.writeUInt8(sha256Pw.readUInt8(i) ^ inner.readUInt8(i), i);
    }
    return out;
}

function sha256(b: Buffer): Buffer {
    const h = crypto.createHash('sha256');
    h.update(b);
    return h.digest();
}
