// sha256_password — legacy (MySQL 5.7) full-auth-only plugin.
//
// No fast-auth cache, so every connection does the public-key RSA dance
// (unless TLS is active, in which case cleartext is sent). Semantics
// otherwise identical to caching_sha2's full-auth path.

import type { AuthCtx, AuthPlugin, AuthStep } from './dispatcher';
import { xorScramblePassword, rsaOaepEncrypt } from './rsa';
import { CACHING_SHA2_REQUEST_PUBLIC_KEY } from '../protocol/messages';

const SCRATCH_PHASE = 'sha256.phase';

type Phase = 'awaiting-pubkey' | 'done';

export const SHA256_PASSWORD: AuthPlugin = {
    name: 'sha256_password',
    initialResponse(ctx: AuthCtx): Buffer {
        if (ctx.password.length === 0) {
            ctx.scratch.set(SCRATCH_PHASE, 'done');
            return Buffer.from([0]); // single NUL byte
        }
        if (ctx.tlsActive) {
            // Cleartext + NUL over TLS.
            const out = Buffer.alloc(ctx.password.length + 1);
            out.write(ctx.password, 0, 'utf8');
            out.writeUInt8(0, ctx.password.length);
            ctx.scratch.set(SCRATCH_PHASE, 'done');
            return out;
        }
        if (!ctx.allowPublicKeyRetrieval) {
            // Fall through: server will ERR. Better UX is to fail locally,
            // but the plugin contract only returns bytes here. The
            // dispatcher will see an ERR packet shortly and surface it.
            ctx.scratch.set(SCRATCH_PHASE, 'done');
            return Buffer.from([0]);
        }
        ctx.scratch.set(SCRATCH_PHASE, 'awaiting-pubkey');
        return Buffer.from([CACHING_SHA2_REQUEST_PUBLIC_KEY]);
    },
    onAuthMoreData(ctx: AuthCtx, payload: Buffer): AuthStep {
        const phase = ctx.scratch.get(SCRATCH_PHASE) as Phase | undefined;
        if (phase === 'awaiting-pubkey') {
            const scrambled = xorScramblePassword(ctx.password, ctx.challenge);
            const encrypted = rsaOaepEncrypt(Buffer.from(payload), scrambled);
            ctx.scratch.set(SCRATCH_PHASE, 'done');
            return { kind: 'write', bytes: encrypted };
        }
        return { kind: 'fail', reason: 'unexpected AuthMoreData for sha256_password' };
    },
};
