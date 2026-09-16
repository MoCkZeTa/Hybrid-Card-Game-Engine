/**
 * Outbound transactional email — currently only password-reset links.
 *
 * Behind an interface for the usual reason plus one specific to this feature:
 * a reset flow you cannot exercise locally is a reset flow that breaks in
 * production without anyone noticing. `ConsoleEmailSender` prints the link to
 * the terminal, so the entire flow — request, token, expiry, single use,
 * session revocation — is testable with no account anywhere and no network.
 *
 * `ResendEmailSender` speaks Resend's REST API through `fetch`, deliberately
 * rather than pulling in `nodemailer` or the `resend` SDK: it is one POST with
 * a JSON body, and this project has kept its dependency surface small on
 * purpose. Swapping in SMTP later means writing one more class, not touching
 * anything that calls this.
 */

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface EmailSender {
  /**
   * Resolves once the message is accepted for delivery. Throws if it was not —
   * callers decide whether that is fatal (it is not, for password reset: see
   * `AuthService.requestPasswordReset`).
   */
  send(message: EmailMessage): Promise<void>;
  /** Shown in the boot banner so it is obvious which sender is live. */
  readonly name: string;
}

/** Development sender: prints the mail, so a reset link is one glance away. */
export class ConsoleEmailSender implements EmailSender {
  readonly name = 'console';

  async send(message: EmailMessage): Promise<void> {
    console.log('\n──────── EMAIL (not actually sent — no RESEND_API_KEY) ────────');
    console.log(`To:      ${message.to}`);
    console.log(`Subject: ${message.subject}`);
    console.log(message.text);
    console.log('───────────────────────────────────────────────────────────────\n');
  }
}

/** Drops every message. For tests that must assert nothing was sent. */
export class NullEmailSender implements EmailSender {
  readonly name = 'null';
  async send(): Promise<void> {
    /* intentionally nothing */
  }
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

export class ResendEmailSender implements EmailSender {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    /** Must be `onboarding@resend.dev` or an address on a domain verified in Resend. */
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    // A hung mail provider must not hold an HTTP request open — the caller is
    // a user waiting on a form submit.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        }),
        signal: abort.signal,
      });

      if (!res.ok) {
        // Resend puts the useful part in the body; the status alone is usually
        // just 422 for "unverified sending domain", which is worth naming.
        const detail = await res.text().catch(() => '');
        throw new Error(`Resend rejected the message (HTTP ${res.status}): ${detail.slice(0, 300)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Picks a sender from the environment. No key means the console sender, which
 * is the right default for local development and an obvious wrong one for
 * production — `validateEnv` refuses to boot a production process without a
 * real key rather than silently mailing nobody.
 */
export function createEmailSenderFromEnv(env: NodeJS.ProcessEnv): EmailSender {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) return new ConsoleEmailSender();
  return new ResendEmailSender(apiKey, env.EMAIL_FROM?.trim() || 'onboarding@resend.dev');
}
