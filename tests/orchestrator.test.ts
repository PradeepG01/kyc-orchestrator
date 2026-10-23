import { MemoryRepository } from '../src/repo/memoryRepo';
import { Orchestrator } from '../src/services/orchestrator';
import { VendorAdapter, defaultVendors, geoVerify } from '../src/vendors/adapters';
import { silentLog, validCustomer } from './helpers';

const opts = { vendorTimeoutMs: 100, vendorRetries: 2, retryBaseDelayMs: 1 };

describe('Orchestrator', () => {
  it('retries a flaky vendor and still completes the check', async () => {
    let calls = 0;
    const flaky: VendorAdapter = {
      ...geoVerify,
      name: 'flaky-geo',
      async call(c) {
        calls += 1;
        if (calls < 3) throw new Error('503 from vendor');
        return geoVerify.call(c);
      },
    } as VendorAdapter;
    const orch = new Orchestrator(new MemoryRepository(), [defaultVendors[0]!, defaultVendors[1]!, flaky], opts, silentLog);
    const v = await orch.verify('t1', { customer: validCustomer() });
    const address = v.checks.find((c) => c.type === 'address')!;
    expect(address.status).toBe('pass');
    expect(address.attempts).toBe(3);
    expect(v.status).toBe('approved');
  });

  it('turns a timed-out vendor into an error and routes the case to manual review', async () => {
    const slow = {
      ...geoVerify,
      name: 'slow-geo',
      call: () => new Promise((resolve) => setTimeout(resolve, 1000)),
    } as unknown as VendorAdapter;
    const orch = new Orchestrator(new MemoryRepository(), [defaultVendors[0]!, defaultVendors[1]!, slow], opts, silentLog);
    const v = await orch.verify('t1', { customer: validCustomer() });
    const address = v.checks.find((c) => c.type === 'address')!;
    expect(address.status).toBe('error');
    expect(address.attempts).toBe(3);
    expect(v.status).toBe('review');
  });

  it('runs vendors in parallel', async () => {
    const delayed = (name: string, base: VendorAdapter) =>
      ({
        ...base,
        name,
        call: async (c: never) => {
          await new Promise((r) => setTimeout(r, 60));
          return base.call(c);
        },
      }) as VendorAdapter;
    const orch = new Orchestrator(
      new MemoryRepository(),
      defaultVendors.map((v) => delayed(v.name, v)),
      { ...opts, vendorTimeoutMs: 500 },
      silentLog,
    );
    const started = Date.now();
    await orch.verify('t1', { customer: validCustomer() });
    expect(Date.now() - started).toBeLessThan(150); // sequential would be >= 180ms
  });
});
