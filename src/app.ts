import { createHash, randomUUID } from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import { Logger } from 'pino';
import { ZodError } from 'zod';
import { CreateVerificationSchema, ReviewSchema, VerificationStatus } from './domain/types';
import { metrics, registry } from './metrics';
import { Repository } from './repo/repository';
import { Orchestrator } from './services/orchestrator';

export interface AppDeps {
  repo: Repository;
  orchestrator: Orchestrator;
  apiKeys: Map<string, string>;
  log: Logger;
}

type AuthedRequest = Request & { tenantId?: string; requestId?: string };

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const VALID_STATUSES = new Set<VerificationStatus>(['approved', 'rejected', 'review']);

export function createApp({ repo, orchestrator, apiKeys, log }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // request id + access log + metrics
  app.use((req: AuthedRequest, res, next) => {
    const started = Date.now();
    req.requestId = req.header('x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', req.requestId);
    res.on('finish', () => {
      const route = req.route?.path ?? req.path;
      metrics.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
      log.info(
        { requestId: req.requestId, method: req.method, route, status: res.statusCode, ms: Date.now() - started },
        'request',
      );
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/metrics', async (_req, res) => {
    res.type(registry.contentType).send(await registry.metrics());
  });

  // API-key auth: the key identifies the tenant, and every query below is scoped to that tenant.
  const auth = (req: AuthedRequest, _res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const tenantId = key ? apiKeys.get(key) : undefined;
    if (!tenantId) return next(new HttpError(401, 'unauthorized', 'missing or invalid API key'));
    req.tenantId = tenantId;
    next();
  };

  app.post('/v1/verifications', auth, async (req: AuthedRequest, res) => {
    const idemKey = req.header('idempotency-key');
    if (!idemKey || idemKey.length > 100) {
      throw new HttpError(400, 'idempotency_key_required', 'send a unique Idempotency-Key header (max 100 chars)');
    }
    const input = CreateVerificationSchema.parse(req.body);
    const tenantId = req.tenantId!;
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');

    const previous = await repo.getIdempotency(tenantId, idemKey);
    if (previous) {
      if (previous.requestHash !== requestHash) {
        throw new HttpError(422, 'idempotency_key_reused', 'Idempotency-Key was already used with a different body');
      }
      const existing = await repo.getVerification(tenantId, previous.verificationId);
      res.setHeader('idempotent-replayed', 'true');
      return res.status(200).json(existing);
    }

    const verification = await orchestrator.verify(tenantId, input);
    await repo.saveIdempotency(tenantId, idemKey, { requestHash, verificationId: verification.id });
    res.status(201).json(verification);
  });

  app.get('/v1/verifications', auth, async (req: AuthedRequest, res) => {
    const status = req.query.status as VerificationStatus | undefined;
    if (status && !VALID_STATUSES.has(status)) throw new HttpError(400, 'invalid_status', 'unknown status filter');
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    res.json({ data: await repo.listVerifications(req.tenantId!, status, limit) });
  });

  app.get('/v1/verifications/:id', auth, async (req: AuthedRequest, res) => {
    const v = await repo.getVerification(req.tenantId!, String(req.params.id));
    if (!v) throw new HttpError(404, 'not_found', 'verification not found');
    res.json(v);
  });

  app.post('/v1/verifications/:id/review', auth, async (req: AuthedRequest, res) => {
    const body = ReviewSchema.parse(req.body);
    const result = await orchestrator.review(req.tenantId!, String(req.params.id), body.decision, body.reviewer, body.note);
    if (result.error === 'not_found') throw new HttpError(404, 'not_found', 'verification not found');
    if (result.error === 'not_in_review') throw new HttpError(409, 'not_in_review', 'only cases in review can be decided');
    res.json(result.verification);
  });

  app.get('/v1/verifications/:id/webhooks', auth, async (req: AuthedRequest, res) => {
    const v = await repo.getVerification(req.tenantId!, String(req.params.id));
    if (!v) throw new HttpError(404, 'not_found', 'verification not found');
    res.json({ data: await repo.listWebhooks(v.id) });
  });

  app.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'route not found')));

  // central error handler: consistent JSON errors, no stack traces leaked to clients
  app.use((err: unknown, req: AuthedRequest, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'validation_failed', details: err.issues });
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json', message: 'request body is not valid JSON' });
    }
    log.error({ err, requestId: req.requestId }, 'unhandled error');
    res.status(500).json({ error: 'internal_error', requestId: req.requestId });
  });

  return app;
}
