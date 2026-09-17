import { Injectable, Logger } from '@nestjs/common';

/**
 * The email port.
 *
 * Shaped like `MessageChannel` beside it and kept separate for one reason: that one
 * addresses people by E.164 phone number, and an email channel that pretended a mailbox
 * was a phone number would make every caller convert between the two.
 *
 * As with WhatsApp and SMS, no provider is wired by default. The unwired implementation
 * reports itself unconfigured and refuses, so a deployment that forgets its SMTP settings
 * fails visibly at the send rather than silently swallowing a password reset.
 */
export interface OutboundEmail {
  to: string;
  subject: string;
  /** Plain text. Every message this product sends is a sentence and a link. */
  text: string;
}

export abstract class EmailChannel {
  abstract readonly configured: boolean;
  abstract send(message: OutboundEmail): Promise<{ providerMessageId: string | null }>;
}

export const EMAIL_CHANNEL = Symbol('EMAIL_CHANNEL');

@Injectable()
export class UnwiredEmailChannel extends EmailChannel {
  readonly configured = false;
  private readonly logger = new Logger(UnwiredEmailChannel.name);

  send(message: OutboundEmail): Promise<{ providerMessageId: string | null }> {
    // Logged at warn with the recipient but never the body: the body of the one email
    // this channel currently sends is a password reset link.
    this.logger.warn(
      `No SMTP provider configured — dropping "${message.subject}" to ${redact(message.to)}`,
    );
    return Promise.reject(new Error('No email provider is configured'));
  }
}

/** `p****a@example.com` — enough to recognise your own address, not enough to harvest. */
export function redact(address: string): string {
  const [local = '', domain = ''] = address.split('@');
  if (local.length <= 2) return `${local.slice(0, 1)}***@${domain}`;
  return `${local.slice(0, 1)}***${local.slice(-1)}@${domain}`;
}

/**
 * A provider reached over HTTP.
 *
 * The body is `{ from, to, subject, text }` — Resend's shape, and near enough to Brevo's
 * and Postmark's that changing provider is a header and a field name rather than a
 * rewrite. Deliberately not SMTP: SMTP would mean a mail library, a connection pool and a
 * set of timeouts, for one message type that is a sentence and a link.
 */
@Injectable()
export class HttpEmailChannel extends EmailChannel {
  readonly configured = true;
  private readonly logger = new Logger(HttpEmailChannel.name);

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly from: string,
  ) {
    super();
  }

  async send(message: OutboundEmail): Promise<{ providerMessageId: string | null }> {
    // A reset the user is waiting on must not hold a request open indefinitely if the
    // provider stops answering.
    const abort = AbortSignal.timeout(10_000);
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      signal: abort,
    });

    if (!response.ok) {
      // The provider's reason, not ours — a 422 for an unverified sender and a 401 for a
      // bad key are different problems and the operator needs to tell them apart. The
      // recipient is redacted; the body is never logged at all.
      const detail = await response.text().catch(() => '');
      this.logger.error(
        `email provider refused (${response.status}) for ${redact(message.to)}: ${detail.slice(0, 200)}`,
      );
      throw new Error(`Email provider responded ${response.status}`);
    }

    const body = (await response.json().catch(() => ({}))) as { id?: string };
    return { providerMessageId: body.id ?? null };
  }
}
