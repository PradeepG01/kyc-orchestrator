import request from 'supertest';
import { createApp } from '../src/app';
import { MemoryRepository } from '../src/repo/memoryRepo';
import { Orchestrator } from '../src/services/orchestrator';
import { defaultVendors } from '../src/vendors/adapters';
import { silentLog, validCustomer } from './helpers';

function setup() {
  const repo = new MemoryRepository();
  const orchestrator = new Orchestrator(repo, defaultVendors, { vendorTimeoutMs: 200, vendorRetries: 1 }, silentLog);
  const apiKeys = new Map([
    ['key-acme', 'acme'],
    ['key-globex', 'globex'],
  ]);
  return { repo, app: createApp({ repo, orchestrator, apiKeys, log: silentLog }) };
}

const ACME = { Authorization: 'Bearer key-acme' };
let n = 0;
const idem = () => ({ 'Idempotency-Key': `idem-${++n}` });

describe('Verifications API', () => {
  it('rejects requests without a valid API key', async () => {
    const { app } = setup();
    await request(app).post('/v1/verifications').send({}).expect(401);
    await request(app).get('/v1/verifications').set('Authorization', 'Bearer nope').expect(401);
  });

  it('requires an Idempotency-Key and validates the body', async () => {
    const { app } = setup();
    await request(app).post('/v1/verifications').set(ACME).send({ customer: validCustomer() }).expect(400);
    const res = await request(app)
      .post('/v1/verifications')
      .set({ ...ACME, ...idem() })
      .send({ customer: { ...validCustomer(), dateOfBirth: '12/04/1996' } })
      .expect(400);
    expect(res.body.error).toBe('validation_failed');
  });

  it('approves a clean customer and returns normalised checks', async () => {
    const { app } = setup();
    const res = await request(app).post('/v1/verifications').set({ ...ACME, ...idem() }).send({ customer: validCustomer() }).expect(201);
    expect(res.body.status).toBe('approved');
    expect(res.body.checks).toHaveLength(3);
    expect(res.body.checks.map((c: { type: string }) => c.type).sort()).toEqual(['address', 'identity_document', 'sanctions_pep']);
  });

  it('rejects a sanctioned individual', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/v1/verifications')
      .set({ ...ACME, ...idem() })
      .send({ customer: validCustomer({ fullName: 'Ivan Kessler Morane' }) })
      .expect(201);
    expect(res.body.status).toBe('rejected');
  });

  it('replays the same response for a retried request and blocks key reuse with a different body', async () => {
    const { app } = setup();
    const headers = { ...ACME, 'Idempotency-Key': 'order-42' };
    const first = await request(app).post('/v1/verifications').set(headers).send({ customer: validCustomer() }).expect(201);
    const retry = await request(app).post('/v1/verifications').set(headers).send({ customer: validCustomer() }).expect(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    await request(app)
      .post('/v1/verifications')
      .set(headers)
      .send({ customer: validCustomer({ fullName: 'Someone Else' }) })
      .expect(422);
  });

  it('isolates tenants from each other', async () => {
    const { app } = setup();
    const created = await request(app).post('/v1/verifications').set({ ...ACME, ...idem() }).send({ customer: validCustomer() });
    await request(app).get(`/v1/verifications/${created.body.id}`).set('Authorization', 'Bearer key-globex').expect(404);
    await request(app).get(`/v1/verifications/${created.body.id}`).set(ACME).expect(200);
  });

  it('supports the manual review workflow', async () => {
    const { app } = setup();
    const partialMatch = await request(app)
      .post('/v1/verifications')
      .set({ ...ACME, ...idem() })
      .send({ customer: validCustomer({ fullName: 'Rajan Malhotra' }) })
      .expect(201);
    expect(partialMatch.body.status).toBe('review');

    const queue = await request(app).get('/v1/verifications?status=review').set(ACME).expect(200);
    expect(queue.body.data.map((v: { id: string }) => v.id)).toContain(partialMatch.body.id);

    const decided = await request(app)
      .post(`/v1/verifications/${partialMatch.body.id}/review`)
      .set(ACME)
      .send({ decision: 'approved', reviewer: 'analyst.priya', note: 'different DOB from PEP entry' })
      .expect(200);
    expect(decided.body.status).toBe('approved');
    expect(decided.body.review.reviewer).toBe('analyst.priya');

    await request(app)
      .post(`/v1/verifications/${partialMatch.body.id}/review`)
      .set(ACME)
      .send({ decision: 'rejected', reviewer: 'analyst.priya' })
      .expect(409);
  });

  it('queues a signed webhook when a callback URL is given', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/v1/verifications')
      .set({ ...ACME, ...idem() })
      .send({ customer: validCustomer(), callbackUrl: 'https://client.example.com/hooks/kyc', externalRef: 'user-981' })
      .expect(201);
    const hooks = await request(app).get(`/v1/verifications/${res.body.id}/webhooks`).set(ACME).expect(200);
    expect(hooks.body.data).toHaveLength(1);
    expect(JSON.parse(hooks.body.data[0].payload)).toMatchObject({
      type: 'verification.completed',
      data: { id: res.body.id, external_ref: 'user-981', status: 'approved' },
    });
  });

  it('returns JSON errors for malformed JSON and unknown routes, and exposes metrics', async () => {
    const { app } = setup();
    await request(app)
      .post('/v1/verifications')
      .set({ ...ACME, ...idem(), 'Content-Type': 'application/json' })
      .send('{bad json')
      .expect(400);
    await request(app).get('/v1/nope').set(ACME).expect(404);
    const metrics = await request(app).get('/metrics').expect(200);
    expect(metrics.text).toContain('http_requests_total');
  });
});
