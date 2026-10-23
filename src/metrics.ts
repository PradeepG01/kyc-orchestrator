import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const metrics = {
  httpRequests: new client.Counter({
    name: 'http_requests_total',
    help: 'HTTP requests by route and status code',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  }),
  vendorLatency: new client.Histogram({
    name: 'vendor_call_duration_seconds',
    help: 'Latency of third-party vendor checks',
    labelNames: ['vendor', 'outcome'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  }),
  verifications: new client.Counter({
    name: 'verifications_total',
    help: 'Verification decisions',
    labelNames: ['status'],
    registers: [registry],
  }),
  webhookDeliveries: new client.Counter({
    name: 'webhook_deliveries_total',
    help: 'Outbound webhook delivery attempts by outcome',
    labelNames: ['outcome'],
    registers: [registry],
  }),
};
