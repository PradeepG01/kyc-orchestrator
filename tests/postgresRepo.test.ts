import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newDb } from 'pg-mem';
import { Verification } from '../src/domain/types';
import { PostgresRepository } from '../src/repo/postgresRepo';
import { validCustomer } from './helpers';

// pg-mem is an in-process PostgreSQL emulator, so the real SQL in PostgresRepository is exercised without a server.
function makeRepo() {
  const db = newDb();
  db.public.none(readFileSync(join(__dirname, '../src/db/schema.sql'), 'utf8'));
  const { Pool } = db.adapters.createPg();
  return new PostgresRepository(new Pool());
}

const verification = (id: string, tenantId: string, status: Verification['status'], createdAt: string): Verification => ({
  id,
  tenantId,
  customer: validCustomer(),
  status,
  riskScore: 10,
  checks: [],
  createdAt,
  updatedAt: createdAt,
});

describe('PostgresRepository', () => {
  it('stores, scopes and filters verifications', async () => {
    const repo = makeRepo();
    await repo.createVerification(verification('v1', 'acme', 'approved', '2026-01-01T00:00:00.000Z'));
    await repo.createVerification(verification('v2', 'acme', 'review', '2026-01-02T00:00:00.000Z'));
    await repo.createVerification(verification('v3', 'globex', 'review', '2026-01-03T00:00:00.000Z'));

    expect((await repo.getVerification('acme', 'v1'))?.status).toBe('approved');
    expect(await repo.getVerification('globex', 'v1')).toBeUndefined();
    expect((await repo.listVerifications('acme')).map((v) => v.id)).toEqual(['v2', 'v1']);
    expect((await repo.listVerifications('acme', 'review')).map((v) => v.id)).toEqual(['v2']);

    const updated = { ...verification('v2', 'acme', 'approved', '2026-01-02T00:00:00.000Z'), updatedAt: '2026-01-05T00:00:00.000Z' };
    await repo.updateVerification(updated);
    expect((await repo.getVerification('acme', 'v2'))?.status).toBe('approved');
  });

  it('keeps the first idempotency record', async () => {
    const repo = makeRepo();
    await repo.saveIdempotency('acme', 'k1', { requestHash: 'h1', verificationId: 'v1' });
    await repo.saveIdempotency('acme', 'k1', { requestHash: 'h2', verificationId: 'v2' });
    expect(await repo.getIdempotency('acme', 'k1')).toEqual({ requestHash: 'h1', verificationId: 'v1' });
  });

  it('claims only due, pending webhooks exactly once', async () => {
    const repo = makeRepo();
    const base = { verificationId: 'v1', url: 'https://x', payload: '{}', attempts: 0, status: 'pending' as const };
    await repo.enqueueWebhook({ ...base, id: 'w1', nextAttemptAt: '2026-01-01T00:00:00.000Z' });
    await repo.enqueueWebhook({ ...base, id: 'w2', nextAttemptAt: '2026-01-01T00:10:00.000Z' });

    const now = new Date('2026-01-01T00:05:00.000Z');
    const claimed = await repo.claimDueWebhooks(now, 10);
    expect(claimed.map((w) => w.id)).toEqual(['w1']);
    expect(claimed[0]!.status).toBe('in_flight');
    expect(await repo.claimDueWebhooks(now, 10)).toEqual([]);

    await repo.updateWebhook({ ...claimed[0]!, status: 'delivered', attempts: 1 });
    expect((await repo.listWebhooks('v1')).find((w) => w.id === 'w1')?.status).toBe('delivered');
  });
});
