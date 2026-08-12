"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encrypt = encrypt;
exports.decrypt = decrypt;
exports.maybeEncrypt = maybeEncrypt;
exports.maybeDecrypt = maybeDecrypt;
const crypto_1 = __importDefault(require("crypto"));
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
function getKey() {
    const hex = process.env.ENCRYPTION_KEY;
    if (!hex || hex.length !== 64) {
        throw new Error('ENCRYPTION_KEY env var missing or not 32 bytes hex');
    }
    return Buffer.from(hex, 'hex');
}
function encrypt(plaintext) {
    if (!plaintext)
        return plaintext;
    const key = getKey();
    const iv = crypto_1.default.randomBytes(IV_LEN);
    const cipher = crypto_1.default.createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: iv(12) + tag(16) + ciphertext — all base64
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
}
function decrypt(ciphertext) {
    if (!ciphertext)
        return ciphertext;
    try {
        const buf = Buffer.from(ciphertext, 'base64');
        const iv = buf.subarray(0, IV_LEN);
        const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
        const encrypted = buf.subarray(IV_LEN + TAG_LEN);
        const decipher = crypto_1.default.createDecipheriv(ALGO, getKey(), iv);
        decipher.setAuthTag(tag);
        return decipher.update(encrypted) + decipher.final('utf8');
    }
    catch {
        // Return as-is if decryption fails (e.g., legacy unencrypted value)
        return ciphertext;
    }
}
// Encrypt only if encryption key is configured. In production a missing key
// means PII would be stored in plaintext — warn loudly once at startup.
if (!process.env.ENCRYPTION_KEY && process.env.NODE_ENV === 'production') {
    console.warn('⚠️  ENCRYPTION_KEY is not set in production — patient PII (names, phones, diagnoses) ' +
        'will be stored UNENCRYPTED. Set a 32-byte hex ENCRYPTION_KEY env var.');
}
function maybeEncrypt(value) {
    if (value == null || value === '')
        return value ?? null;
    if (!process.env.ENCRYPTION_KEY)
        return value;
    return encrypt(value);
}
function maybeDecrypt(value) {
    if (value == null || value === '')
        return value ?? null;
    if (!process.env.ENCRYPTION_KEY)
        return value;
    return decrypt(value);
}
