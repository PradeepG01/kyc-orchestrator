import { Verification, VerificationStatus, WebhookDelivery } from '../domain/types';
import { IdempotencyRecord, Repository } from './repository';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryRepository implements Repository {
  private verifications = new Map<string, Verification>();
  private idempotency = new Map<string, IdempotencyRecord>();
  private webhooks = new Map<string, WebhookDelivery>();

  async createVerification(v: Verification) {
    this.verifications.set(v.id, clone(v));
  }

  async updateVerification(v: Verification) {
    this.verifications.set(v.id, clone(v));
  }

  async getVerification(tenantId: string, id: string) {
    const v = this.verifications.get(id);
    return v && v.tenantId === tenantId ? clone(v) : undefined;
  }

  async listVerifications(tenantId: string, status?: VerificationStatus, limit = 50) {
    return [...this.verifications.values()]
      .filter((v) => v.tenantId === tenantId && (!status || v.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async getIdempotency(tenantId: string, key: string) {
    return this.idempotency.get(`${tenantId}:${key}`);
  }

  async saveIdempotency(tenantId: string, key: string, record: IdempotencyRecord) {
    this.idempotency.set(`${tenantId}:${key}`, record);
  }

  async enqueueWebhook(d: WebhookDelivery) {
    this.webhooks.set(d.id, clone(d));
  }

  async claimDueWebhooks(now: Date, limit: number) {
    const due = [...this.webhooks.values()]
      .filter((d) => d.status === 'pending' && new Date(d.nextAttemptAt) <= now)
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))
      .slice(0, limit);
    for (const d of due) d.status = 'in_flight';
    return due.map(clone);
  }

  async updateWebhook(d: WebhookDelivery) {
    this.webhooks.set(d.id, clone(d));
  }

  async listWebhooks(verificationId: string) {
    return [...this.webhooks.values()].filter((d) => d.verificationId === verificationId).map(clone);
  }
}
