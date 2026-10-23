import { createHmac } from 'node:crypto';
import { Logger } from 'pino';
import { WebhookDelivery } from '../domain/types';
import { metrics } from '../metrics';
import { Repository } from '../repo/repository';
import { withTimeout } from './resilience';

export function signPayload(secret: string, timestamp: string, payload: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`;
}

export interface DispatcherOptions {
  secret: string;
  maxAttempts: number;
  baseDelayMs: number;
  timeoutMs?: number;
  batchSize?: number;
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
}>;

/**
 * Delivers outbound webhooks from the outbox table. Failed deliveries are retried with exponential
 * backoff (base, 2x, 4x, ...) and moved to 'dead' after maxAttempts so they can be inspected/replayed.
 */
export class WebhookDispatcher {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repo: Repository,
    private readonly opts: DispatcherOptions,
    private readonly log: Logger,
    private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
  ) {}

  async runOnce(now = new Date()): Promise<number> {
    const due = await this.repo.claimDueWebhooks(now, this.opts.batchSize ?? 20);
    await Promise.all(due.map((d) => this.deliver(d, now)));
    return due.length;
  }

  private async deliver(d: WebhookDelivery, now: Date) {
    const timestamp = Math.floor(now.getTime() / 1000).toString();
    const attempts = d.attempts + 1;
    try {
      const res = await withTimeout(
        () =>
          this.fetchFn(d.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Timestamp': timestamp,
              'X-Signature': signPayload(this.opts.secret, timestamp, d.payload),
            },
            body: d.payload,
          }),
        this.opts.timeoutMs ?? 5000,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await this.repo.updateWebhook({ ...d, attempts, status: 'delivered', lastError: undefined });
      metrics.webhookDeliveries.inc({ outcome: 'delivered' });
    } catch (err) {
      const dead = attempts >= this.opts.maxAttempts;
      const next = new Date(now.getTime() + this.opts.baseDelayMs * 2 ** (attempts - 1));
      await this.repo.updateWebhook({
        ...d,
        attempts,
        status: dead ? 'dead' : 'pending',
        nextAttemptAt: next.toISOString(),
        lastError: (err as Error).message,
      });
      metrics.webhookDeliveries.inc({ outcome: dead ? 'dead' : 'retry' });
      this.log.warn({ deliveryId: d.id, attempts, dead, err: (err as Error).message }, 'webhook delivery failed');
    }
  }

  start(intervalMs: number) {
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => this.log.error({ err }, 'webhook dispatcher error'));
    }, intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
