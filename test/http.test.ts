import { describe, expect, test, vi } from 'vitest';
import { createJsonFetcher } from '@/http.js';

/** A fetch stand-in that answers every call with one canned response. */
function fakeFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response as Response);
}

describe('createJsonFetcher', () => {
  test('returns parsed JSON on a 200', async () => {
    const fetchJson = createJsonFetcher({
      fetchImpl: fakeFetch({ ok: true, status: 200, json: async () => ({ hello: 'world' }) }),
      userAgent: 'test/1.0',
      rateLimitMs: 0,
    });

    const result = await fetchJson('https://example.test/thing');

    expect(result).toEqual({ ok: true, data: { hello: 'world' } });
  });

  test('sends the user agent on every request', async () => {
    const impl = fakeFetch({ ok: true, status: 200, json: async () => ({}) });
    const fetchJson = createJsonFetcher({
      fetchImpl: impl,
      userAgent: 'listening-log/0.1.0 (someone@example.test)',
      rateLimitMs: 0,
    });

    await fetchJson('https://example.test/thing');

    const headers = (impl.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers['User-Agent']).toBe('listening-log/0.1.0 (someone@example.test)');
  });

  test('merges caller-supplied headers with the user agent', async () => {
    const impl = fakeFetch({ ok: true, status: 200, json: async () => ({}) });
    const fetchJson = createJsonFetcher({ fetchImpl: impl, userAgent: 'ua', rateLimitMs: 0 });

    await fetchJson('https://example.test/thing', { Authorization: 'Bearer token' });

    const headers = (impl.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token');
    expect(headers['User-Agent']).toBe('ua');
  });

  /** A 404 is a clean answer ("not in the catalog"), not a failure to answer. */
  test('reports a 404 as notFound without a warning', async () => {
    const warnings: string[] = [];
    const fetchJson = createJsonFetcher({
      fetchImpl: fakeFetch({ ok: false, status: 404 }),
      userAgent: 'ua',
      rateLimitMs: 0,
      warnings,
    });

    const result = await fetchJson('https://example.test/missing');

    expect(result).toEqual({ ok: false, notFound: true, failed: false });
    expect(warnings).toEqual([]);
  });

  test('reports a non-404 HTTP error as a failure and warns', async () => {
    const warnings: string[] = [];
    const fetchJson = createJsonFetcher({
      fetchImpl: fakeFetch({ ok: false, status: 503 }),
      userAgent: 'ua',
      rateLimitMs: 0,
      warnings,
    });

    const result = await fetchJson('https://example.test/down');

    expect(result).toEqual({ ok: false, notFound: false, failed: true });
    expect(warnings[0]).toContain('503');
  });

  test('reports a transport error as a failure and warns', async () => {
    const warnings: string[] = [];
    const fetchJson = createJsonFetcher({
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      userAgent: 'ua',
      rateLimitMs: 0,
      warnings,
    });

    const result = await fetchJson('https://example.test/unreachable');

    expect(result.ok).toBe(false);
    expect(warnings[0]).toContain('ECONNREFUSED');
  });

  test('reports an unparseable body as a failure and warns', async () => {
    const warnings: string[] = [];
    const fetchJson = createJsonFetcher({
      fetchImpl: fakeFetch({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('Unexpected token');
        },
      }),
      userAgent: 'ua',
      rateLimitMs: 0,
      warnings,
    });

    const result = await fetchJson('https://example.test/garbage');

    expect(result.ok).toBe(false);
    expect(warnings[0]).toContain('unparseable');
  });

  test('spaces successive requests by rateLimitMs', async () => {
    vi.useFakeTimers();
    try {
      const impl = fakeFetch({ ok: true, status: 200, json: async () => ({}) });
      const state = { nextAllowedAt: 0 };
      const fetchJson = createJsonFetcher({
        fetchImpl: impl,
        userAgent: 'ua',
        rateLimitMs: 1000,
        rateLimiterState: state,
      });

      await fetchJson('https://example.test/one');
      expect(impl).toHaveBeenCalledTimes(1);

      const second = fetchJson('https://example.test/two');
      await vi.advanceTimersByTimeAsync(999);
      expect(impl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(impl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('shares one rate-limit budget across fetchers given the same state', async () => {
    vi.useFakeTimers();
    try {
      const state = { nextAllowedAt: 0 };
      const implA = fakeFetch({ ok: true, status: 200, json: async () => ({}) });
      const implB = fakeFetch({ ok: true, status: 200, json: async () => ({}) });
      const options = { userAgent: 'ua', rateLimitMs: 1000, rateLimiterState: state };

      await createJsonFetcher({ ...options, fetchImpl: implA })('https://a.test/');
      const pending = createJsonFetcher({ ...options, fetchImpl: implB })('https://b.test/');

      await vi.advanceTimersByTimeAsync(999);
      expect(implB).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(implB).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
