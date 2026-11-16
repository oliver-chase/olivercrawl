import type { CrawlTarget } from '@/core/types';

/** A resolver that answers every host with one public address, so no test needs real DNS. */
export const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

/** An allowed, active target for one host. */
export const site = (host: string): CrawlTarget => ({ baseUrl: `https://${host}`, robotsPolicy: 'allow', active: true });

/** An HTML response. `url` stands in for the final URL a followed redirect leaves behind. */
export function htmlResponse(body: string, init: { status?: number; headers?: Record<string, string>; url?: string } = {}) {
  const response = new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/html', ...(init.headers ?? {}) },
  });
  if (init.url) Object.defineProperty(response, 'url', { value: init.url });
  return response;
}

/** An HTML response whose page has a title and carries `body` inside main. */
export const htmlPage = (body: string) =>
  htmlResponse(`<html><head><title>T</title></head><body><main>${body}</main></body></html>`);

/** Page markup with one paragraph of real copy and an anchor for each link. */
export const linkedDoc = (links: string[] = []) =>
  `<html><head><title>T</title></head><body><main><p>Weekly concerts at the riverside stage all summer long.</p>${links
    .map((l) => `<a href="${l}">x</a>`)
    .join('')}</main></body></html>`;

/** A body that never ends, counting the bytes the reader pulled. */
export function endlessBody(counter: { bytes: number }): Response {
  const chunk = new Uint8Array(64 * 1024).fill(97);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      counter.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
}
