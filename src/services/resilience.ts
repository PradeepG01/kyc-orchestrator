export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries transient failures with exponential backoff plus jitter. Returns the result and attempts used. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { retries, baseDelayMs = 50, isRetryable = () => true }: { retries: number; baseDelayMs?: number; isRetryable?: (e: unknown) => boolean },
): Promise<{ value: T; attempts: number }> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return { value: await fn(), attempts: attempt };
    } catch (err) {
      if (attempt > retries || !isRetryable(err)) {
        (err as { attempts?: number }).attempts = attempt;
        throw err;
      }
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * baseDelayMs);
      await sleep(delay);
    }
  }
}
