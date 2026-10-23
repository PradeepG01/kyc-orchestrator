import { CheckResult, VerificationStatus } from './types';

/** Relative importance of each check in the overall risk score. */
const WEIGHTS: Record<CheckResult['type'], number> = {
  sanctions_pep: 0.5,
  identity_document: 0.35,
  address: 0.15,
};

export const APPROVE_BELOW = 30;
export const REJECT_AT_OR_ABOVE = 70;

export function riskScore(checks: CheckResult[]): number {
  const total = checks.reduce((sum, c) => sum + WEIGHTS[c.type] * c.score, 0);
  const weight = checks.reduce((sum, c) => sum + WEIGHTS[c.type], 0);
  return weight === 0 ? 100 : Math.round(total / weight);
}

/**
 * Decision rules, in priority order:
 *  1. A confirmed sanctions match is an automatic rejection.
 *  2. Any vendor error or "needs review" sends the case to a human analyst (never auto-approve on missing data).
 *  3. Otherwise the weighted score decides: low risk approves, high risk rejects, the middle band goes to review.
 */
export function decide(checks: CheckResult[]): { status: VerificationStatus; score: number } {
  const score = riskScore(checks);
  if (checks.some((c) => c.type === 'sanctions_pep' && c.status === 'fail')) return { status: 'rejected', score: 100 };
  if (checks.some((c) => c.status === 'error' || c.status === 'needs_review')) return { status: 'review', score };
  if (score < APPROVE_BELOW) return { status: 'approved', score };
  if (score >= REJECT_AT_OR_ABOVE) return { status: 'rejected', score };
  return { status: 'review', score };
}
