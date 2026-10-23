import pino from 'pino';
import { Customer } from '../src/domain/types';

export const silentLog = pino({ level: 'silent' });

export const validCustomer = (overrides: Partial<Customer> = {}): Customer => ({
  fullName: 'Asha Rao',
  dateOfBirth: '1996-04-12',
  country: 'IN',
  documentType: 'passport',
  documentNumber: 'K1234567',
  address: { line1: '12 MG Road, Indiranagar', city: 'Bengaluru', postalCode: '560038' },
  ...overrides,
});
