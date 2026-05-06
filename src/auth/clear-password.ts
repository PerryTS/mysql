// mysql_clear_password — send the password verbatim, null-terminated.
//
// Only safe over TLS. We refuse to send plaintext over plain TCP.
// The server-side plugin is used for LDAP / PAM auth flows where the
// server proxy relays the password to an external verifier.

import type { AuthCtx, AuthPlugin } from './dispatcher';

export const MYSQL_CLEAR_PASSWORD: AuthPlugin = {
    name: 'mysql_clear_password',
    initialResponse(ctx: AuthCtx): Buffer {
        if (!ctx.tlsActive) {
            throw new Error('mysql_clear_password requires TLS; refusing to send plaintext');
        }
        const out = Buffer.alloc(ctx.password.length + 1);
        out.write(ctx.password, 0, 'utf8');
        out.writeUInt8(0, ctx.password.length);
        return out;
    },
};
