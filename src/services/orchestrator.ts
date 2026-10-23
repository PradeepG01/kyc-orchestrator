import { createHash, randomUUID } from 'node:crypto';
import { Logger } from 'pino';
import { decide } from '../domain/risk';
import { CheckResult, CreateVerificationInput, Customer, Verification } from '../domain/types';
import { metrics } from '../metrics';
import { Repository } from '../repo/repository';
import { VendorAdapter } from '../vendors/adapters';
import { withRetry, withTimeout } from './resilience';
import { TtlCache } from './ttlCache';

export interface OrchestratorOptions {
  vendorTimeoutMs: number;
  vendorRetries: number;
  retryBaseDelayMs?: number;
  /** Cache successful vendor results for identical customer data; 0 disables caching. */
  cacheTtlMs?: number;
}

type CachedCheck = Pick<CheckResult, 'status' | 'score' | 'reasons'>;

export class Orchestrator {
  readonly cache: TtlCache<CachedCheck>;

  constructor(
    private readonly repo: Repository,
    private readonly vendors: VendorAdapter[],
    private readonly opts: OrchestratorOptions,
    private readonly log: Logger,
  ) {
    this.cache = new TtlCache<CachedCheck>(opts.cacheTtlMs ?? 0);
  }

  /** Calls one vendor with timeout + retries and normalises its answer. Never throws: failures become 'error'. */
  private async runCheck(vendor: VendorAdapter, customer: Customer): Promise<CheckResult> {
    const cacheKey = `${vendor.name}:${createHash('sha256').update(JSON.stringify(customer)).digest('hex')}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { type: vendor.type, vendor: vendor.name, ...cached, latencyMs: 0, attempts: 0, cached: true };
    }
    const started = Date.now();
    try {
      const { value, attempts } = await withRetry(
        () => withTimeout(() => vendor.call(customer), this.opts.vendorTimeoutMs),
        { retries: this.opts.vendorRetries, baseDelayMs: this.opts.retryBaseDelayMs ?? 50 },
      );
      const normalized = vendor.normalize(value);
      this.cache.set(cacheKey, normalized); // errors are never cached, so a vendor outage is retried next time
      const latencyMs = Date.now() - started;
      metrics.vendorLatency.observe({ vendor: vendor.name, outcome: normalized.status }, latencyMs / 1000);
      return { type: vendor.type, vendor: vendor.name, ...normalized, latencyMs, attempts };
    } catch (err) {
      const latencyMs = Date.now() - started;
      metrics.vendorLatency.observe({ vendor: vendor.name, outcome: 'error' }, latencyMs / 1000);
      this.log.warn({ vendor: vendor.name, err: (err as Error).message }, 'vendor check failed');
      return {
        type: vendor.type,
        vendor: vendor.name,
        status: 'error',
        score: 50,
        reasons: [`VENDOR_UNAVAILABLE: ${(err as Error).message}`],
        latencyMs,
        attempts: (err as { attempts?: number }).attempts ?? 1,
      };
    }
  }

  async verify(tenantId: string, input: CreateVerificationInput): Promise<Verification> {
    // Vendors are independent, so they run in parallel: total latency ~= slowest vendor, not the sum.
    const checks = await Promise.all(this.vendors.map((v) => this.runCheck(v, input.customer)));
    const { status, score } = decide(checks);
    const now = new Date().toISOString();
    const verification: Verification = {
      id: `ver_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      tenantId,
      externalRef: input.externalRef,
      customer: input.customer,
      status,
      riskScore: score,
      checks,
      callbackUrl: input.callbackUrl,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.createVerification(verification);
    metrics.verifications.inc({ status });
    await this.notify(verification, 'verification.completed');
    this.log.info({ id: verification.id, tenantId, status, score }, 'verification completed');
    return verification;
  }

  async review(tenantId: string, id: string, decision: 'approved' | 'rejected', reviewer: string, note?: string) {
    const verification = await this.repo.getVerification(tenantId, id);
    if (!verification) return { error: 'not_found' as const };
    if (verification.status !== 'review') return { error: 'not_in_review' as const };
    const now = new Date().toISOString();
    const updated: Verification = {
      ...verification,
      status: decision,
      review: { reviewer, note, decidedAt: now },
      updatedAt: now,
    };
    await this.repo.updateVerification(updated);
    metrics.verifications.inc({ status: decision });
    await this.notify(updated, 'verification.reviewed');
    return { verification: updated };
  }

  /** Transactional-outbox style: the webhook is stored first, then delivered asynchronously with retries. */
  private async notify(v: Verification, type: string) {
    if (!v.callbackUrl) return;
    const payload = JSON.stringify({
      id: `evt_${randomUUID()}`,
      type,
      created_at: new Date().toISOString(),
      data: { id: v.id, external_ref: v.externalRef, status: v.status, risk_score: v.riskScore },
    });
    await this.repo.enqueueWebhook({
      id: randomUUID(),
      verificationId: v.id,
      url: v.callbackUrl,
      payload,
      attempts: 0,
      status: 'pending',
      nextAttemptAt: new Date().toISOString(),
    });
  }
}
