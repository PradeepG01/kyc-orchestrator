# KYC Orchestrator

A **TypeScript / Node.js microservice** that verifies customers for fintech apps. One API call fans out to
identity-document, sanctions/PEP and address vendors **in parallel**, normalises their different responses,
computes a **risk score**, auto-decides or routes the case to **manual review**, and notifies the client with
**HMAC-signed webhooks** delivered with retries.

![CI](https://github.com/PradeepG01/kyc-orchestrator/actions/workflows/ci.yml/badge.svg)

## Architecture

```
client ──► POST /v1/verifications  (Bearer API key → tenant, Idempotency-Key)
              │  zod validation
              ▼
         Orchestrator ──┬─► docucheck        (identity document)   ┐ each call: timeout + retries
                        ├─► watchlist-screen (sanctions / PEP)     │ with exponential backoff;
                        └─► geoverify        (address)             ┘ failures become 'error', never crash
              │  normalise → weighted risk score → decision rules
              ▼
         Repository (PostgreSQL | in-memory) ──► outbox: webhook_deliveries
                                                        │
                                   WebhookDispatcher ◄──┘  claim due rows atomically, sign, POST,
                                                           retry 1s/2s/4s… then mark 'dead'
```

| Concern | Implementation |
|---|---|
| REST API | Express 5, `src/app.ts`, documented in `openapi.yaml` |
| Validation | zod schemas, `src/domain/types.ts` |
| Auth + multi-tenancy | API key → tenant; every query is tenant-scoped |
| Idempotency | `Idempotency-Key` header + request hash; safe client retries, conflicting reuse → 422 |
| Third-party integrations | Vendor adapter interface + response normalisation, `src/vendors/adapters.ts` |
| Resilience | `withTimeout`, `withRetry` (exponential backoff + jitter), `src/services/resilience.ts` |
| Caching | TTL + LRU cache of vendor results for repeated identical checks (cuts vendor cost and latency), `src/services/ttlCache.ts` |
| Decision engine | Weighted scoring + priority rules, `src/domain/risk.ts` |
| Case management | `review` queue + analyst decision endpoint |
| Outbound webhooks | Transactional outbox, HMAC-SHA256 signatures, backoff, dead-lettering |
| Storage | Repository pattern: PostgreSQL (parameterised SQL) and in-memory |
| Observability | pino structured logs with request ids, Prometheus metrics (`/metrics`) |
| Delivery | Multi-stage Dockerfile, docker-compose, GitHub Actions (unit + Postgres integration), Kubernetes + HPA |

## Run it

```bash
npm install
npm run dev                                  # in-memory storage, API key "dev-key"
# or with PostgreSQL
docker compose up --build
```

```bash
curl -X POST localhost:3000/v1/verifications \
  -H 'Authorization: Bearer dev-key' -H 'Idempotency-Key: signup-123' -H 'Content-Type: application/json' \
  -d '{"customer":{"fullName":"Asha Rao","dateOfBirth":"1996-04-12","country":"IN","documentType":"passport",
       "documentNumber":"K1234567","address":{"line1":"12 MG Road, Indiranagar","city":"Bengaluru","postalCode":"560038"}},
       "callbackUrl":"https://example.com/hooks/kyc"}'
```

Try `"fullName": "Viktor Drago Petrov"` (sanctions hit → rejected) or `"Rajan Malhotra"` (partial PEP match → review).

## Tests

```bash
npm test            # 29 tests: domain rules, vendors, orchestration, caching, API, webhooks, PostgreSQL repository
npm run typecheck
```

The PostgreSQL repository is tested against **pg-mem** (an in-process Postgres emulator); CI also runs a smoke test
against a real PostgreSQL 16 service container.

## Design decisions

* **Never auto-approve on missing data:** a vendor timeout produces an `error` check, which forces manual review.
* **Parallel fan-out** keeps latency at the slowest vendor rather than the sum of all vendors (tested).
* **Outbox pattern:** the webhook is stored in the same database as the decision, so a crash between "decide" and
  "notify" cannot lose the notification; delivery happens asynchronously with retries.
* **Atomic claiming** (`UPDATE … WHERE status='pending' … RETURNING`) lets several replicas run the dispatcher safely.

> Vendors are deterministic simulations so the service runs without paid accounts; swap `call()` for a real HTTP
> integration to go live. Watchlist names are fictional.
