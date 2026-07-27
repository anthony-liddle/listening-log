/**
 * The outcome of one JSON request.
 *
 * The three states are deliberately distinct because callers treat them
 * differently. `notFound` is a clean answer ("the catalog does not have this"),
 * which is worth remembering. `failed` means the service never answered, which
 * is worth retrying on the next build and must never be cached as a fact.
 */
export type JsonResult =
  | { ok: true; data: unknown }
  | { ok: false; notFound: boolean; failed: boolean };

/** Millisecond timestamp of the earliest moment the next request may go out. */
export interface RateLimiterState {
  nextAllowedAt: number;
}

export interface JsonFetcherOptions {
  /** Injectable fetch. Defaults to globalThis.fetch. The seam tests rely on. */
  fetchImpl?: typeof globalThis.fetch;
  /** Sent on every request. Discogs asks callers to identify themselves. */
  userAgent: string;
  /** Minimum milliseconds between requests. */
  rateLimitMs?: number;
  /**
   * Shared budget. Pass one object to every fetcher in a run and the rate limit
   * applies across the whole batch rather than per call site, which is the only
   * way the limit means anything when two services are queried in one pass.
   */
  rateLimiterState?: RateLimiterState;
  /** Soft failures are appended here rather than thrown. */
  warnings?: string[];
}

/** A JSON fetch bound to a user agent, a rate limit, and a warnings sink. */
export type JsonFetcher = (url: string, headers?: Record<string, string>) => Promise<JsonResult>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a JSON fetcher that identifies itself, honors a rate limit, and reports
 * failures as values instead of exceptions.
 *
 * Nothing here throws. A catalog being briefly unreachable should degrade a
 * build to "this album has no cover yet", not fail it, so every failure mode
 * comes back as a JsonResult the caller can decide about.
 */
export function createJsonFetcher(options: JsonFetcherOptions): JsonFetcher {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const rateLimitMs = options.rateLimitMs ?? 0;
  const warnings = options.warnings ?? [];
  const limiter = options.rateLimiterState ?? { nextAllowedAt: 0 };

  return async (url, headers = {}) => {
    if (rateLimitMs > 0) {
      const now = Date.now();
      if (now < limiter.nextAllowedAt) {
        await sleep(limiter.nextAllowedAt - now);
      }
      limiter.nextAllowedAt = Date.now() + rateLimitMs;
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { ...headers, 'User-Agent': options.userAgent },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Request to ${url} failed: ${message}`);
      return { ok: false, notFound: false, failed: true };
    }

    // A 404 is an answer, not a failure, so it carries no warning. What it
    // means depends on the caller: a lookup by ID treats it as a dead end
    // worth remembering, a fallback search just moves on.
    if (response.status === 404) {
      return { ok: false, notFound: true, failed: false };
    }

    if (!response.ok) {
      warnings.push(`Request to ${url} returned ${response.status}`);
      return { ok: false, notFound: false, failed: true };
    }

    try {
      return { ok: true, data: await response.json() };
    } catch {
      warnings.push(`Request to ${url} returned an unparseable response`);
      return { ok: false, notFound: false, failed: true };
    }
  };
}
