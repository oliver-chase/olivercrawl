// Live checks of the local Chromium render rung.

import { createCrawler, isLocalRenderAvailable, renderViaLocalChromium } from '../../dist/index.js';
import { USER_AGENT, IANA, dns, check, assert } from './harness.mjs';

export async function renderChecks() {

  console.log('\nRendering');
  // The render rung runs end to end only here: the unit suite cannot drive a real browser at a real URL,
  // and the host guard refuses the private addresses a local test server binds to.
  //
  // renderWhenTextBelow above any real page length makes every fetch look thin, so the ladder escalates
  // to render on a page that fetched fine.
  {
    if (!(await isLocalRenderAvailable())) {
      console.log('  (playwright not installed — local render checks skipped)');
    } else {
      const renderCrawler = createCrawler({
        userAgent: USER_AGENT,
        dnsLookup: dns,
        minHostIntervalMs: 500,
        localRender: true,
        renderWhenTextBelow: 10_000_000,
      });

      await check('local Chromium renders a real page', async () => {
        const r = await renderCrawler.crawl(IANA, 'https://www.iana.org/help/example-domains');
        assert(r.ok, `${r.reason}: ${r.detail}`);
        const page = r.pages[0];
        assert(page.rung === 'local-render', `escalated to ${page.rung}, expected local-render`);
        assert(page.text.length > 0, 'rendered page had no text');
        return `${page.text.length} chars`;
      });

      await check('a rendered page has the same shape as a fetched one', async () => {
        // PAGE-SHAPE-1: a rung returning a thinner page than its neighbours shows
        // up as worse extraction and gets blamed on the site.
        const r = await renderCrawler.crawl(IANA, 'https://www.iana.org/help/example-domains');
        assert(r.ok, `${r.reason}: ${r.detail}`);
        const page = r.pages[0];
        // Any HTML-derived rung satisfies the shape, so the rung itself is asserted first.
        assert(page.rung === 'local-render', `shape checked on ${page.rung}, expected local-render`);
        assert(/^[a-f0-9]{64}$/.test(page.textSha256), 'textSha256 missing — change detection would be dead for this rung');
        assert(/^[a-f0-9]{64}$/.test(page.bodySha256), 'bodySha256 missing');
        // Rendered output IS HTML, so the HTML-derived fields must be populated
        // and not empty the way a prose rung leaves them.
        assert(/^[a-f0-9]{64}$/.test(page.contentRegionSha256), 'contentRegionSha256 empty on an HTML-derived rung');
        assert(page.markdown.length > 0, 'markdown empty on an HTML-derived rung');
        assert(Array.isArray(page.links) && Array.isArray(page.jsonLd), 'array fields not arrays');
        return `markdown ${page.markdown.length}, ${page.links.length} links`;
      });

      await check('a redirect chain leaving the site is refused BEFORE the hop', async () => {
        // RENDER-HOP-2 driven in a real browser: an off-site chain that returns
        // home, which a landing check alone passes because it sees the original host.
        const chain =
          'https://nghttp2.org/httpbin/redirect-to?url=' +
          encodeURIComponent('https://httpbin.org/redirect-to?url=' + encodeURIComponent('https://nghttp2.org/httpbin/get'));
        const reasons = [];
        const html = await renderViaLocalChromium(chain, true, [], dns, (r) => reasons.push(r));
        assert(html === null, 'an off-site redirect chain rendered anyway');
        assert(reasons.length > 0, 'the refusal was silent (RENDER-SILENT-1)');
        assert(/off-domain|Blocked/i.test(reasons[0]), `refused for an unrelated reason: ${reasons[0]}`);
        return reasons[0].slice(0, 44);
      });

      await check('a same-site redirect still renders', async () => {
        // A guard that also refused the ordinary case would leave the render rung
        // quietly never working.
        const same =
          'https://nghttp2.org/httpbin/redirect-to?url=' + encodeURIComponent('https://nghttp2.org/httpbin/get');
        const html = await renderViaLocalChromium(same, true, [], dns, () => {});
        assert(html !== null, 'a same-site redirect was refused');
        assert(html.length > 0, 'same-site redirect returned empty html');
        return `${html.length} chars`;
      });

      await check('the render rung reports what it did', async () => {
        // The crawler reports each render through onUsage, so an operator can tell
        // a render that ran from a rung that never started.
        const events = [];
        const guarded = createCrawler({
          userAgent: USER_AGENT,
          dnsLookup: dns,
          minHostIntervalMs: 500,
          localRender: true,
          renderWhenTextBelow: 10_000_000,
          onUsage: (e) => events.push(e),
        });
        await guarded.crawl(
          { baseUrl: 'https://www.rfc-editor.org', robotsPolicy: 'allow', active: true },
          'https://www.rfc-editor.org/rfc/rfc9309.html',
        );
        const rendered = events.filter((e) => e.rung === 'local-render');
        assert(rendered.length > 0, 'render rung emitted no usage event at all');
        assert(rendered.some((e) => e.ok), 'no successful render event');
        return `${rendered.length} render events, ${rendered.filter((e) => e.ok).length} ok`;
      });
    }
  }
}
