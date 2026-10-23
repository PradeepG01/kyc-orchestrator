import { Pool } from 'pg';
import { Verification, VerificationStatus, WebhookDelivery } from '../domain/types';
import { IdempotencyRecord, Repository } from './repository';

type Row = Record<string, unknown>;

const toIso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const parseJson = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : (v as T));

function toWebhook(r: Row): WebhookDelivery {
  return {
    id: String(r.id),
    verificationId: String(r.verification_id),
    url: String(r.url),
    payload: String(r.payload),
    attempts: Number(r.attempts),
    status: r.status as WebhookDelivery['status'],
    nextAttemptAt: toIso(r.next_attempt_at),
    lastError: (r.last_error as string | null) ?? undefined,
  };
}

/** PostgreSQL adapter. All queries are parameterised ($1, $2...) to prevent SQL injection. */
export class PostgresRepository implements Repository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async createVerification(v: Verification) {
    await this.pool.query(
      `INSERT INTO verifications (id, tenant_id, external_ref, status, risk_score, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [v.id, v.tenantId, v.externalRef ?? null, v.status, v.riskScore, JSON.stringify(v), v.createdAt, v.updatedAt],
    );
  }

  async updateVerification(v: Verification) {
    await this.pool.query(
      `UPDATE verifications SET status = $3, risk_score = $4, data = $5, updated_at = $6
       WHERE id = $1 AND tenant_id = $2`,
      [v.id, v.tenantId, v.status, v.riskScore, JSON.stringify(v), v.updatedAt],
    );
  }

  async getVerification(tenantId: string, id: string) {
    const { rows } = await this.pool.query(`SELECT data FROM verifications WHERE id = $1 AND tenant_id = $2`, [
      id,
      tenantId,
    ]);
    return rows[0] ? parseJson<Verification>(rows[0].data) : undefined;
  }

  async listVerifications(tenantId: string, status?: VerificationStatus, limit = 50) {
    const { rows } = status
      ? await this.pool.query(
          `SELECT data FROM verifications WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3`,
          [tenantId, status, limit],
        )
      : await this.pool.query(`SELECT data FROM verifications WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`, [
          tenantId,
          limit,
        ]);
    return rows.map((r: Row) => parseJson<Verification>(r.data));
  }

  async getIdempotency(tenantId: string, key: string) {
    const { rows } = await this.pool.query(
      `SELECT request_hash, verification_id FROM idempotency_keys WHERE tenant_id = $1 AND idem_key = $2`,
      [tenantId, key],
    );
    const r = rows[0] as Row | undefined;
    return r ? { requestHash: String(r.request_hash), verificationId: String(r.verification_id) } : undefined;
  }

  async saveIdempotency(tenantId: string, key: string, record: IdempotencyRecord) {
    await this.pool.query(
      `INSERT INTO idempotency_keys (tenant_id, idem_key, request_hash, verification_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, idem_key) DO NOTHING`,
      [tenantId, key, record.requestHash, record.verificationId],
    );
  }

  async enqueueWebhook(d: WebhookDelivery) {
    await this.pool.query(
      `INSERT INTO webhook_deliveries (id, verification_id, url, payload, attempts, status, next_attempt_at, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [d.id, d.verificationId, d.url, d.payload, d.attempts, d.status, d.nextAttemptAt, d.lastError ?? null],
    );
  }

  async claimDueWebhooks(now: Date, limit: number) {
    // The outer "status = 'pending'" is re-checked after row locks are acquired, so two workers
    // racing for the same rows cannot both claim them.
    const { rows } = await this.pool.query(
      `UPDATE webhook_deliveries SET status = 'in_flight'
       WHERE status = 'pending' AND id IN (
         SELECT id FROM webhook_deliveries
         WHERE status = 'pending' AND next_attempt_at <= $1
         ORDER BY next_attempt_at LIMIT $2)
       RETURNING *`,
      [now.toISOString(), limit],
    );
    return rows.map(toWebhook);
  }

  async updateWebhook(d: WebhookDelivery) {
    await this.pool.query(
      `UPDATE webhook_deliveries SET attempts = $2, status = $3, next_attempt_at = $4, last_error = $5 WHERE id = $1`,
      [d.id, d.attempts, d.status, d.nextAttemptAt, d.lastError ?? null],
    );
  }

  async listWebhooks(verificationId: string) {
    const { rows } = await this.pool.query(`SELECT * FROM webhook_deliveries WHERE verification_id = $1`, [
      verificationId,
    ]);
    return rows.map(toWebhook);
  }
}
