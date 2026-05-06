// Shared RSA-OAEP helper for caching_sha2_password and sha256_password
// full-auth paths.
//
// Both plugins agree that:
//   1. The client XORs the (null-terminated) plaintext password with the
//      challenge, repeating the challenge as needed.
//   2. The XOR'd bytes are encrypted with the server's RSA public key
//      using RSA-OAEP-SHA1 padding (OAEP_MGF1 = SHA-1).
//
// The result is returned as the auth response bytes.

import * as crypto from 'node:crypto';

/** Build the XOR'd password (plaintext + NUL, XOR'd with the challenge). */
export function xorScramblePassword(password: string, challenge: Buffer): Buffer {
    const pwWithNul = Buffer.alloc(password.length + 1);
    pwWithNul.write(password, 0, 'utf8');
    pwWithNul.writeUInt8(0, password.length);
    const out = Buffer.alloc(pwWithNul.length);
    for (let i = 0; i < pwWithNul.length; i++) {
        const chByte = challenge.readUInt8(i % challenge.length);
        out.writeUInt8(pwWithNul.readUInt8(i) ^ chByte, i);
    }
    return out;
}

/** RSA-OAEP-SHA1 encrypt `message` with a PEM-format public key. */
export function rsaOaepEncrypt(pemKey: Buffer, message: Buffer): Buffer {
    return crypto.publicEncrypt(
        {
            key: pemKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha1',
        },
        message,
    );
}
