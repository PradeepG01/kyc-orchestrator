import { createHmac } from 'node:crypto';
import { WebhookDelivery } from '../src/domain/types';
import { MemoryRepository } from '../src/repo/memoryRepo';
import { WebhookDispatcher } from '../src/services/webhookDispatcher';
import { silentLog } from './helpers';

const delivery = (overrides: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
  id: 'd1',
  verificationId: 'ver_1',
  url: 'https://client.example.com/hook',
  payload: '{"type":"verification.completed"}',
  attempts: 0,
  status: 'pending',
  nextAttemptAt: new Date(0).toISOString(),
  ...overrides,
});

describe('WebhookDispatcher', () => {
  it('delivers with a verifiable HMAC signature', async () => {
    const repo = new MemoryRepository();
    await repo.enqueueWebhook(delivery());
    const sent: { headers: Record<string, string>; body: string }[] = [];
    const dispatcher = new WebhookDispatcher(repo, { secret: 's3cret', maxAttempts: 3, baseDelayMs: 1000 }, silentLog, async (_url, init) => {
      sent.push(init);
      return { ok: true, status: 200 };
    });

    expect(await dispatcher.runOnce(new Date())).toBe(1);
    const { headers, body } = sent[0]!;
    const expected = createHmac('sha256', 's3cret').update(`${headers['X-Timestamp']}.${body}`).digest('hex');
    expect(headers['X-Signature']).toBe(`sha256=${expected}`);
    expect((await repo.listWebhooks('ver_1'))[0]!.status).toBe('delivered');
    expect(await dispatcher.runOnce(new Date())).toBe(0); // not re-sent
  });

  it('retries with exponential backoff and gives up after maxAttempts', async () => {
    const repo = new MemoryRepository();
    await repo.enqueueWebhook(delivery());
    const dispatcher = new WebhookDispatcher(repo, { secret: 's', maxAttempts: 3, baseDelayMs: 1000 }, silentLog, async () => ({
      ok: false,
      status: 500,
    }));

    const t0 = new Date('2026-01-01T00:00:00Z');
    await dispatcher.runOnce(t0);
    let [d] = await repo.listWebhooks('ver_1');
    expect(d).toMatchObject({ attempts: 1, status: 'pending', lastError: 'HTTP 500' });
    expect(new Date(d!.nextAttemptAt).getTime() - t0.getTime()).toBe(1000);

    expect(await dispatcher.runOnce(new Date(t0.getTime() + 500))).toBe(0); // not due yet

    const t1 = new Date(t0.getTime() + 1000);
    await dispatcher.runOnce(t1);
    [d] = await repo.listWebhooks('ver_1');
    expect(new Date(d!.nextAttemptAt).getTime() - t1.getTime()).toBe(2000);

    await dispatcher.runOnce(new Date(t1.getTime() + 2000));
    [d] = await repo.listWebhooks('ver_1');
    expect(d).toMatchObject({ attempts: 3, status: 'dead' });
  });
});
