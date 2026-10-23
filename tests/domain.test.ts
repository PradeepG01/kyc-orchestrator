import { decide, riskScore } from '../src/domain/risk';
import { CheckResult } from '../src/domain/types';
import { ageOn, docuCheck, geoVerify, watchlistScreen } from '../src/vendors/adapters';
import { validCustomer } from './helpers';

const check = (type: CheckResult['type'], status: CheckResult['status'], score: number): CheckResult => ({
  type,
  vendor: 'v',
  status,
  score,
  reasons: [],
  latencyMs: 1,
  attempts: 1,
});

describe('risk decision', () => {
  it('approves low-risk customers', () => {
    const r = decide([check('identity_document', 'pass', 3), check('sanctions_pep', 'pass', 0), check('address', 'pass', 5)]);
    expect(r.status).toBe('approved');
  });

  it('auto-rejects a confirmed sanctions match regardless of other checks', () => {
    const r = decide([check('identity_document', 'pass', 0), check('sanctions_pep', 'fail', 100), check('address', 'pass', 0)]);
    expect(r).toEqual({ status: 'rejected', score: 100 });
  });

  it('never auto-approves when a vendor errored', () => {
    const r = decide([check('identity_document', 'pass', 0), check('sanctions_pep', 'error', 50), check('address', 'pass', 0)]);
    expect(r.status).toBe('review');
  });

  it('weights the score by check importance', () => {
    expect(riskScore([check('sanctions_pep', 'pass', 100), check('address', 'pass', 0)])).toBe(77);
  });
});

describe('vendor normalisation', () => {
  it('flags an invalid passport number', async () => {
    const raw = await docuCheck.call(validCustomer({ documentNumber: '12345' }));
    expect(docuCheck.normalize(raw)).toMatchObject({ status: 'fail', reasons: ['DOCUMENT_NUMBER_INVALID'] });
  });

  it('sends minors to review', async () => {
    const dob = `${new Date().getUTCFullYear() - 16}-01-01`;
    const raw = await docuCheck.call(validCustomer({ dateOfBirth: dob }));
    expect(docuCheck.normalize(raw).status).toBe('needs_review');
  });

  it('computes age correctly around birthdays', () => {
    expect(ageOn('2000-06-15', new Date('2026-06-14T00:00:00Z'))).toBe(25);
    expect(ageOn('2000-06-15', new Date('2026-06-15T00:00:00Z'))).toBe(26);
  });

  it('detects exact and partial watchlist matches', async () => {
    const exact = watchlistScreen.normalize(await watchlistScreen.call(validCustomer({ fullName: 'Viktor Drago Petrov' })));
    const partial = watchlistScreen.normalize(await watchlistScreen.call(validCustomer({ fullName: 'Viktor Petrov' })));
    const clean = watchlistScreen.normalize(await watchlistScreen.call(validCustomer()));
    expect(exact.status).toBe('fail');
    expect(partial.status).toBe('needs_review');
    expect(clean.status).toBe('pass');
  });

  it('validates postal codes per country', async () => {
    const bad = geoVerify.normalize(await geoVerify.call(validCustomer({ address: { line1: '12 MG Road', city: 'B', postalCode: '012345' } })));
    const unsupported = geoVerify.normalize(await geoVerify.call(validCustomer({ country: 'ZZ' })));
    expect(bad.status).toBe('fail');
    expect(unsupported.status).toBe('needs_review');
  });
});
