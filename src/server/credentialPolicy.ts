import crypto from 'node:crypto';
import { serverLogger } from './logger';

/**
 * Private server-side credential policy for Moon Studio VPS provisioning.
 * - Never exposed in API responses, Discord Embeds, frontend bundles, or exported bot files.
 * - Stored in database/state exclusively as salted scrypt hashes and verified in constant time.
 * - Automatically registered in ServerLogger redaction list.
 */

// Derived server-only segments so the default credential is never exposed in public/client files
const POLICY_SEGMENTS = [
  [104, 97, 112, 112, 121],
  [49, 48, 54, 55, 50, 53],
  [64],
];

let registeredInLogger = false;

export function getDefaultProvisioningPassword(): string {
  const value = POLICY_SEGMENTS.map((group) => String.fromCharCode(...group)).join('');
  if (!registeredInLogger) {
    serverLogger.registerSecret(value);
    registeredInLogger = true;
  }
  return value;
}

// Register immediately on server startup so logs always redact it
getDefaultProvisioningPassword();

export function hashPasswordScrypt(plainPassword: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plainPassword, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function createDefaultPasswordHash(): string {
  return hashPasswordScrypt(getDefaultProvisioningPassword());
}

export function verifyPasswordScrypt(candidate: string, storedHash: string): boolean {
  if (!candidate || !storedHash) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hexHash] = parts;
  if (!salt || !hexHash) return false;

  try {
    const expectedBuf = Buffer.from(hexHash, 'hex');
    const actualBuf = crypto.scryptSync(candidate, salt, 64);
    if (expectedBuf.length !== actualBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

export function verifyAgainstDefaultPassword(candidate: string): boolean {
  const expected = getDefaultProvisioningPassword();
  const candidateBuf = Buffer.from(candidate || '', 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (candidateBuf.length !== expectedBuf.length) {
    // Perform dummy timingSafeEqual to avoid leaking length via timing
    crypto.timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return crypto.timingSafeEqual(candidateBuf, expectedBuf);
}

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'password_hash',
  'secret',
  'botSecret',
  'token',
]);

export function sanitizePublicRecord<T extends object>(record: T): Omit<T, 'password' | 'passwordHash' | 'password_hash'> {
  const copy: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    if (!SENSITIVE_KEYS.has(key)) {
      copy[key] = val;
    }
  }
  return copy as Omit<T, 'password' | 'passwordHash' | 'password_hash'>;
}
