import { Verification, VerificationStatus, WebhookDelivery } from '../domain/types';

export interface IdempotencyRecord {
  requestHash: string;
  verificationId: string;
}

/** Storage port. Two adapters implement it: in-memory (dev/tests) and PostgreSQL (production). */
export interface Repository {
  createVerification(v: Verification): Promise<void>;
  updateVerification(v: Verification): Promise<void>;
  getVerification(tenantId: string, id: string): Promise<Verification | undefined>;
  listVerifications(tenantId: string, status?: VerificationStatus, limit?: number): Promise<Verification[]>;

  getIdempotency(tenantId: string, key: string): Promise<IdempotencyRecord | undefined>;
  saveIdempotency(tenantId: string, key: string, record: IdempotencyRecord): Promise<void>;

  enqueueWebhook(d: WebhookDelivery): Promise<void>;
  /** Atomically claims due deliveries (status -> in_flight) so several replicas never send the same one twice. */
  claimDueWebhooks(now: Date, limit: number): Promise<WebhookDelivery[]>;
  updateWebhook(d: WebhookDelivery): Promise<void>;
  listWebhooks(verificationId: string): Promise<WebhookDelivery[]>;
}
