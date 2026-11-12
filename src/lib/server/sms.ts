export type SmsResult = { delivered: boolean; provider: 'twilio' | 'dev' };

function twilioConfig() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (!accountSid || !authToken || !messagingServiceSid) return null;
  return { accountSid, authToken, messagingServiceSid };
}

export function isSmsConfigured(): boolean {
  return twilioConfig() !== null;
}

/**
 * Sends an SMS through Twilio's Messaging Service. When Twilio is not configured
 * outside production it resolves with provider 'dev' and sends nothing; in
 * production a missing config is an error so OTPs are never silently dropped.
 */
export async function sendSms(toE164: string, body: string): Promise<SmsResult> {
  const config = twilioConfig();
  if (!config) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMS provider is not configured');
    }
    console.log(`[sms] dev mode, not sent to ${toE164.slice(0, 4)}***${toE164.slice(-2)} (Twilio not configured)`);
    return { delivered: false, provider: 'dev' };
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: toE164,
        MessagingServiceSid: config.messagingServiceSid,
        Body: body,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { code?: number; message?: string };
    // Log the provider code only; never the phone number or message body.
    console.error(`Twilio SMS failed: status=${response.status} code=${detail.code ?? 'n/a'} ${detail.message ?? ''}`);
    throw new Error('Could not send SMS');
  }
  const sent = (await response.json().catch(() => ({}))) as { sid?: string; status?: string };
  // Masked number only; "queued" means Twilio accepted it, not that the phone received it.
  console.log(`[sms] ${toE164.slice(0, 4)}***${toE164.slice(-2)} sid=${sent.sid ?? 'n/a'} status=${sent.status ?? 'n/a'}`);
  return { delivered: true, provider: 'twilio' };
}
