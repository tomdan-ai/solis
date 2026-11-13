import { createHmac } from 'crypto';

const PHONE_HASH_VERSION = 'hmac_v1';
const DEVELOPMENT_HMAC_KEY = 'solis-development-phone-hmac-key';

export function normalizePhone(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Phone number is required');
  }

  const trimmed = value.trim();
  let digits = trimmed.replace(/^\+/, '').replace(/\D/g, '');
  // Nigerian local format (0803 123 4567): swap the trunk 0 for the country code.
  if (!trimmed.startsWith('+') && /^0\d{10}$/.test(digits)) {
    digits = `234${digits.slice(1)}`;
  }
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('Phone number must be a valid international number');
  }

  return `+${digits}`;
}

export function hashPhone(phone: string): string {
  const key = process.env.PHONE_HMAC_KEY ?? (
    process.env.NODE_ENV === 'production' ? null : DEVELOPMENT_HMAC_KEY
  );
  if (!key) {
    throw new Error('PHONE_HMAC_KEY is not configured');
  }

  const digest = createHmac('sha256', key).update(phone).digest('hex');
  return `${PHONE_HASH_VERSION}:${digest}`;
}

export function phoneHashFromInput(value: unknown): string {
  return hashPhone(normalizePhone(value));
}

/** Raw 32-byte digest (hex, no prefix) for on-chain use, from a stored `hmac_v1:<hex>` hash. */
export function phoneHashToHex(phoneHash: string): string {
  const hex = phoneHash.replace(/^hmac_v1:/, '').replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('phoneHash must contain 32 bytes');
  }
  return hex.toLowerCase();
}

/** Country allow-list (E.164 calling codes, no +). Default: Nigeria only. */
export function isAllowedCountry(e164: string): boolean {
  const allowed = (process.env.SMS_ALLOWED_COUNTRY_CODES ?? '234')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
  const digits = e164.replace(/^\+/, '');
  if (!allowed.some((code) => digits.startsWith(code))) return false;
  // Nigeria: +234 followed by a 10-digit national number.
  if (digits.startsWith('234') && digits.length !== 13) return false;
  return true;
}
