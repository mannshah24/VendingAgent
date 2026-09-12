/**
 * Shared utility functions used by both the server middleware and agent client.
 * Kept in a neutral location to avoid cross-boundary import issues.
 */
import crypto from 'crypto';

export function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function decodeX402Token(token: string): Record<string, unknown> {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    throw new Error('Invalid x402 token: unable to decode payload');
  }
}
