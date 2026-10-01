import type {
  OtpDeliveryProvider,
  OtpDeliveryRequest,
  OtpDeliveryResult,
} from './notification.contracts.js';

/**
 * Development provider. Satisfies the same contract as a real email/SMS adapter
 * so wiring is identical in both environments.
 *
 * The code is deliberately NOT logged — only its length — so a log sink can
 * never become an OTP disclosure vector. Local development reads the code from
 * an in-memory out-of-band channel instead.
 */
export class ConsoleOtpDeliveryProvider implements OtpDeliveryProvider {
  readonly name = 'console';

  private readonly outbox = new Map<string, OtpDeliveryRequest[]>();

  async send(request: OtpDeliveryRequest): Promise<OtpDeliveryResult> {
    const target = request.recipientEmail ?? request.recipientPhone ?? 'unknown';
    const key = `${request.purpose}:${target}`;

    const existing = this.outbox.get(key) ?? [];
    existing.push(request);
    this.outbox.set(key, existing);

    return Promise.resolve({
      delivered: true,
      providerMessageId: `console-${target}`,
    });
  }

  /** Test/local helper: the most recent code sent to a destination. */
  peek(purpose: OtpDeliveryRequest['purpose'], destination: string): string | null {
    const bucket = this.outbox.get(`${purpose}:${destination}`);
    const last = bucket?.[bucket.length - 1];
    return last?.code ?? null;
  }

  reset(): void {
    this.outbox.clear();
  }
}