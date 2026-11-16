import { describe, expect, test } from 'vitest';
import { assertLandedSameSite } from '@/fetch/local-render';
import { publicDns } from '../helpers';

// RENDER-REDIRECT-1: page.goto follows the whole redirect chain inside
// Chromium, and the caller then builds the page with the URL it ASKED for. An
// origin could bounce this rung anywhere — including a private address — and
// have that content returned under the original URL.

const privateDns = async () => [{ address: '127.0.0.1', family: 4 }];
const asked = 'https://site.example.com/x';

describe('the browser must land where it was sent', () => {
  test.each([
    ['same host', 'https://site.example.com/final', 'https://site.example.com/start'],
    ['www and apex are the same site', 'https://www.site.example.com/x', asked],
  ])('%s passes', async (_name, landed, start) => {
    await expect(assertLandedSameSite(landed, start, publicDns)).resolves.toBeUndefined();
  });

  test.each([
    ['an off-site landing', 'https://attacker.example.net/collect', publicDns, /off-domain/i],
    // Subdomains are frequently a different publisher; only www is folded.
    ['a subdomain', 'https://internal.site.example.com/x', publicDns, /off-domain/i],
    // DNS rebinding between the policy check and the browser's own lookup.
    ['a private-resolving landing on the same host', asked, privateDns, undefined],
    ['a file: landing', 'file:///etc/passwd', publicDns, undefined],
    // A hostname-only comparison would allow cross-port, credentialed and
    // scheme-changing landings. The canonical redirect guard refuses all three, and
    // the landing check delegates to it.
    ['a cross-port landing', 'https://site.example.com:8443/x', publicDns, /cross-port/i],
    ['an https to http downgrade', 'http://site.example.com/x', publicDns, undefined],
    ['a credentialed landing URL', 'https://admin:pw@site.example.com/x', publicDns, /credential/i],
  ])('%s is refused', async (_name, landed, dns, message) => {
    await expect(assertLandedSameSite(landed, asked, dns)).rejects.toThrow(message);
  });
});
