import { MemoryRepository } from '../src/repo/memoryRepo';
import { Orchestrator } from '../src/services/orchestrator';
import { TtlCache } from '../src/services/ttlCache';
import { VendorAdapter, geoVerify } from '../src/vendors/adapters';
import { silentLog, validCustomer } from './helpers';

describe('TtlCache', () => {
  it('expires entries after the TTL and evicts the least recently used', () => {
    let now = 0;
    const cache = new TtlCache<number>(1000, 2, () => now);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // 'a' is now most recently used
    cache.set('c', 3); // evicts 'b'
    expect(cache.get('b')).toBeUndefined();
    now = 1500;
    expect(cache.get('a')).toBeUndefined(); // expired
  });
});

describe('vendor result caching', () => {
  const counting = () => {
    const calls = { n: 0 };
    const vendor = {
      ...geoVerify,
      async call(c: never) {
        calls.n += 1;
        return geoVerify.call(c);
      },
    } as VendorAdapter;
    return { vendor, calls };
  };

  it('reuses a recent identical check instead of calling the vendor again', async () => {
    const { vendor, calls } = counting();
    const orch = new Orchestrator(new MemoryRepository(), [vendor], { vendorTimeoutMs: 100, vendorRetries: 0, cacheTtlMs: 60_000 }, silentLog);
    await orch.verify('t1', { customer: validCustomer() });
    const second = await orch.verify('t1', { customer: validCustomer() });
    expect(calls.n).toBe(1);
    expect(second.checks[0]!.cached).toBe(true);

    await orch.verify('t1', { customer: validCustomer({ fullName: 'Different Person' }) });
    expect(calls.n).toBe(2); // different input -> cache miss
  });

  it('does not cache when TTL is 0', async () => {
    const { vendor, calls } = counting();
    const orch = new Orchestrator(new MemoryRepository(), [vendor], { vendorTimeoutMs: 100, vendorRetries: 0 }, silentLog);
    await orch.verify('t1', { customer: validCustomer() });
    await orch.verify('t1', { customer: validCustomer() });
    expect(calls.n).toBe(2);
  });
});
