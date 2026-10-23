import { z } from 'zod';

export const CustomerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD'),
  country: z.string().length(2).toUpperCase(), // ISO 3166-1 alpha-2
  documentType: z.enum(['passport', 'national_id', 'driving_licence']),
  documentNumber: z.string().trim().min(5).max(20),
  address: z.object({
    line1: z.string().min(3),
    city: z.string().min(2),
    postalCode: z.string().min(3).max(10),
  }),
});

export const CreateVerificationSchema = z.object({
  customer: CustomerSchema,
  callbackUrl: z.string().url().optional(),
  externalRef: z.string().max(64).optional(),
});

export const ReviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reviewer: z.string().min(2).max(64),
  note: z.string().max(500).optional(),
});

export type Customer = z.infer<typeof CustomerSchema>;
export type CreateVerificationInput = z.infer<typeof CreateVerificationSchema>;
export type ReviewInput = z.infer<typeof ReviewSchema>;

export type CheckType = 'identity_document' | 'sanctions_pep' | 'address';
export type CheckStatus = 'pass' | 'fail' | 'needs_review' | 'error';
export type VerificationStatus = 'approved' | 'rejected' | 'review';

/** A vendor response normalised into one shape, regardless of which provider produced it. */
export interface CheckResult {
  type: CheckType;
  vendor: string;
  status: CheckStatus;
  score: number; // 0 (no risk) .. 100 (max risk)
  reasons: string[];
  latencyMs: number;
  attempts: number;
  cached?: boolean;
}

export interface Verification {
  id: string;
  tenantId: string;
  externalRef?: string;
  customer: Customer;
  status: VerificationStatus;
  riskScore: number;
  checks: CheckResult[];
  callbackUrl?: string;
  review?: { reviewer: string; note?: string; decidedAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  verificationId: string;
  url: string;
  payload: string;
  attempts: number;
  status: 'pending' | 'in_flight' | 'delivered' | 'dead';
  nextAttemptAt: string;
  lastError?: string;
}
