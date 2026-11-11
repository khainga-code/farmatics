import type { SmsProvider } from '../config.js';

export interface SmsSender {
  send(to: string, message: string): Promise<void>;
}

class StubSmsSender implements SmsSender {
  async send(to: string, message: string): Promise<void> {
    // Development only. The code is also returned in the API response while
    // NODE_ENV is not production, so nothing has to be typed from a log.
    console.log(`[sms:stub] to ${to}: ${message}`);
  }
}

/**
 * Africa's Talking is the usual Kenyan provider. Credentials come from the
 * environment; without them the sender refuses rather than silently dropping
 * a one-time code.
 *
 * UNTESTED until an account is provisioned - see the Phase 1 notes.
 */
class AfricaStalkingSender implements SmsSender {
  constructor(
    private readonly username: string,
    private readonly apiKey: string,
    private readonly senderId?: string,
  ) {}

  async send(to: string, message: string): Promise<void> {
    const body = new URLSearchParams({
      username: this.username,
      to,
      message,
      ...(this.senderId ? { from: this.senderId } : {}),
    });

    const response = await fetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: {
        apiKey: this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`SMS provider rejected the message: ${response.status}`);
    }
  }
}

export function createSmsSender(provider: SmsProvider): SmsSender {
  if (provider === 'africastalking') {
    const username = process.env['AFRICASTALKING_USERNAME'];
    const apiKey = process.env['AFRICASTALKING_API_KEY'];
    if (!username || !apiKey) {
      throw new Error(
        'SMS_PROVIDER=africastalking needs AFRICASTALKING_USERNAME and AFRICASTALKING_API_KEY',
      );
    }
    return new AfricaStalkingSender(username, apiKey, process.env['AFRICASTALKING_SENDER_ID']);
  }
  return new StubSmsSender();
}
