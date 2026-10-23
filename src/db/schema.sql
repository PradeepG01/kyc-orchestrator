-- KYC orchestrator schema (PostgreSQL)

CREATE TABLE IF NOT EXISTS verifications (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  external_ref TEXT,
  status       TEXT        NOT NULL,
  risk_score   INTEGER     NOT NULL,
  data         JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verifications_tenant_status ON verifications (tenant_id, status, created_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id       TEXT NOT NULL,
  idem_key        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  verification_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idem_key)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT PRIMARY KEY,
  verification_id TEXT        NOT NULL,
  url             TEXT        NOT NULL,
  payload         TEXT        NOT NULL,
  attempts        INTEGER     NOT NULL DEFAULT 0,
  status          TEXT        NOT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhooks_due ON webhook_deliveries (status, next_attempt_at);
