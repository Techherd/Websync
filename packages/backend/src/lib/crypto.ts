import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

let cachedKey: Buffer | null = null;

const resolveSecretPath = (): string => {
    if (process.env.WEBSYNC_SECRET_FILE) return process.env.WEBSYNC_SECRET_FILE;
    const dataDir = fs.existsSync('/data') ? '/data' : path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    return path.join(dataDir, '.secret');
};

const loadKey = (): Buffer => {
    if (cachedKey) return cachedKey;

    if (process.env.WEBSYNC_SECRET_KEY) {
        const raw = process.env.WEBSYNC_SECRET_KEY.trim();
        // Accept hex (64 chars) or base64; fall back to sha256 derivation
        if (/^[0-9a-fA-F]{64}$/.test(raw)) {
            cachedKey = Buffer.from(raw, 'hex');
        } else {
            try {
                const buf = Buffer.from(raw, 'base64');
                cachedKey = buf.length === KEY_LENGTH ? buf : crypto.createHash('sha256').update(raw).digest();
            } catch {
                cachedKey = crypto.createHash('sha256').update(raw).digest();
            }
        }
        return cachedKey;
    }

    const secretPath = resolveSecretPath();
    if (fs.existsSync(secretPath)) {
        const raw = fs.readFileSync(secretPath, 'utf8').trim();
        if (/^[0-9a-fA-F]{64}$/.test(raw)) {
            cachedKey = Buffer.from(raw, 'hex');
            return cachedKey;
        }
    }

    const generated = crypto.randomBytes(KEY_LENGTH);
    fs.writeFileSync(secretPath, generated.toString('hex'), { mode: 0o600 });
    try { fs.chmodSync(secretPath, 0o600); } catch {}
    console.log(`[crypto] Generated new secret key at ${secretPath}`);
    cachedKey = generated;
    return cachedKey;
};

export const encrypt = (plaintext: string): string => {
    const key = loadKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString('base64');
};

export const decrypt = (payload: string): string => {
    const key = loadKey();
    const buf = Buffer.from(payload, 'base64');
    if (buf.length < IV_LENGTH + TAG_LENGTH) {
        throw new Error('Encrypted payload is too short');
    }
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};
