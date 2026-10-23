/**
 * Vendor adapters. Each third-party provider returns a different response shape; adapters hide that
 * behind one interface and `normalize()` maps raw responses to a common CheckResult.
 *
 * The three providers here are realistic simulations (deterministic rules over the input) so the
 * service runs without paid vendor accounts. Replacing one with a real HTTP integration only means
 * implementing `call()` with fetch.
 */
import { CheckResult, CheckType, Customer } from '../domain/types';

export interface VendorAdapter<Raw = unknown> {
  readonly name: string;
  readonly type: CheckType;
  call(customer: Customer): Promise<Raw>;
  normalize(raw: Raw): Pick<CheckResult, 'status' | 'score' | 'reasons'>;
}

// --------------------------------------------------------------- identity document
interface DocuCheckResponse {
  result: 'CLEAR' | 'CONSIDER' | 'REJECTED';
  confidence: number;
  flags: string[];
}

const DOCUMENT_PATTERNS: Record<Customer['documentType'], RegExp> = {
  passport: /^[A-Z][0-9]{7}$/,
  national_id: /^[0-9]{12}$/,
  driving_licence: /^[A-Z]{2}[0-9]{6,14}$/,
};

export function ageOn(dateOfBirth: string, today = new Date()): number {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < dob.getUTCMonth() ||
    (today.getUTCMonth() === dob.getUTCMonth() && today.getUTCDate() < dob.getUTCDate());
  return beforeBirthday ? age - 1 : age;
}

export const docuCheck: VendorAdapter<DocuCheckResponse> = {
  name: 'docucheck',
  type: 'identity_document',
  async call(customer) {
    const flags: string[] = [];
    if (!DOCUMENT_PATTERNS[customer.documentType].test(customer.documentNumber.replace(/\s/g, ''))) {
      flags.push('DOCUMENT_NUMBER_INVALID');
    }
    if (ageOn(customer.dateOfBirth) < 18) flags.push('UNDERAGE');
    if (flags.includes('DOCUMENT_NUMBER_INVALID')) return { result: 'REJECTED', confidence: 0.99, flags };
    if (flags.length) return { result: 'CONSIDER', confidence: 0.8, flags };
    return { result: 'CLEAR', confidence: 0.97, flags };
  },
  normalize(raw) {
    if (raw.result === 'CLEAR') return { status: 'pass', score: Math.round((1 - raw.confidence) * 100), reasons: [] };
    if (raw.result === 'CONSIDER') return { status: 'needs_review', score: 60, reasons: raw.flags };
    return { status: 'fail', score: 90, reasons: raw.flags };
  },
};

// --------------------------------------------------------------- sanctions / PEP
interface WatchlistResponse {
  searched_lists: string[];
  hits: { list: string; name: string; match_strength: number }[];
}

// Fictional entries used for demos and tests.
const WATCHLIST = [
  { list: 'OFAC-SDN', name: 'viktor drago petrov' },
  { list: 'UN-CONSOLIDATED', name: 'ivan kessler morane' },
  { list: 'PEP-IN', name: 'rajan malhotra singh' },
];

const tokens = (name: string) => new Set(name.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean));

export const watchlistScreen: VendorAdapter<WatchlistResponse> = {
  name: 'watchlist-screen',
  type: 'sanctions_pep',
  async call(customer) {
    const query = tokens(customer.fullName);
    const hits = WATCHLIST.flatMap((entry) => {
      const entryTokens = tokens(entry.name);
      const shared = [...query].filter((t) => entryTokens.has(t)).length;
      const strength = shared / Math.max(entryTokens.size, query.size);
      return strength >= 0.5 ? [{ list: entry.list, name: entry.name, match_strength: Number(strength.toFixed(2)) }] : [];
    });
    return { searched_lists: [...new Set(WATCHLIST.map((w) => w.list))], hits };
  },
  normalize(raw) {
    const best = raw.hits.reduce((max, h) => Math.max(max, h.match_strength), 0);
    if (best >= 0.99) return { status: 'fail', score: 100, reasons: raw.hits.map((h) => `${h.list}: ${h.name}`) };
    if (best > 0) return { status: 'needs_review', score: 65, reasons: raw.hits.map((h) => `possible match ${h.list}`) };
    return { status: 'pass', score: 0, reasons: [] };
  },
};

// --------------------------------------------------------------- address
interface GeoVerifyResponse {
  code: 'MATCH' | 'PARTIAL' | 'NO_MATCH' | 'UNSUPPORTED_COUNTRY';
}

const POSTAL_FORMATS: Record<string, RegExp> = {
  IN: /^[1-9][0-9]{5}$/,
  GB: /^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$/i,
  US: /^[0-9]{5}(-[0-9]{4})?$/,
  SG: /^[0-9]{6}$/,
  AE: /^.{3,10}$/,
};

export const geoVerify: VendorAdapter<GeoVerifyResponse> = {
  name: 'geoverify',
  type: 'address',
  async call(customer) {
    const format = POSTAL_FORMATS[customer.country];
    if (!format) return { code: 'UNSUPPORTED_COUNTRY' };
    if (!format.test(customer.address.postalCode.trim())) return { code: 'NO_MATCH' };
    return { code: customer.address.line1.trim().length >= 8 ? 'MATCH' : 'PARTIAL' };
  },
  normalize(raw) {
    switch (raw.code) {
      case 'MATCH':
        return { status: 'pass', score: 5, reasons: [] };
      case 'PARTIAL':
        return { status: 'pass', score: 35, reasons: ['ADDRESS_PARTIAL_MATCH'] };
      case 'NO_MATCH':
        return { status: 'fail', score: 80, reasons: ['POSTAL_CODE_INVALID'] };
      default:
        return { status: 'needs_review', score: 50, reasons: ['COUNTRY_NOT_SUPPORTED'] };
    }
  },
};

export const defaultVendors: VendorAdapter[] = [docuCheck, watchlistScreen, geoVerify] as VendorAdapter[];
