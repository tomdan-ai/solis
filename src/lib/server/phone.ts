import { createHmac } from 'crypto';

const PHONE_HASH_VERSION = 'hmac_v1';
const DEVELOPMENT_HMAC_KEY = 'solis-development-phone-hmac-key';

export function normalizePhone(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Phone number is required');
  }

  const digits = value.replace(/^\+/, '').replace(/\D/g, '');
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
