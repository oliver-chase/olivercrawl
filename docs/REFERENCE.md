# Reference

How each feature behaves past the basics. The [README](../README.md) covers installing, the first crawl, the retrieval ladder, failures and configuration, and [API](API.md) lists every export and option.

## What the guard reports on a page

```ts
if (result.ok && !result.notModified) {
  const page = result.pages[0]!;
  page.truncated;       // text or markdown hit maxTextChars, so the tail was never seen
  page.redactionCount;  // above 0 when an injection pattern was found and masked
}
```

Neither is recoverable afterwards, which is why both are reported. A truncated page is one whose end you do not have, and a non-zero `redactionCount` means the text differs from what the origin served. Both change how far you should trust an extraction taken from that page.

### When a page is quarantined

`result.quarantine` carries what tripped the guard and enough of the page to review it. Without it a quarantine looks like a timeout at your call site, and the page is dropped silently, which is the outcome quarantining exists to prevent.

```ts
if (!result.ok && result.reason === 'quarantined') {
  result.quarantine.signals;  // which rules fired, with the matched text
  result.quarantine.text;     // sanitized page text, redactions already applied
  result.quarantine.title;
}
```

The text is sanitized, so a reviewer sees what the page said and the copy carries no working instruction to paste into a model.

### When the origin has moved

`result.originMoved` is present on a successful crawl when the direct fetch was refused for leaving the site and a fallback rung served the page anyway.

```ts
if (result.ok && !result.notModified && result.originMoved) {
  result.originMoved.refusal;   // the guard message, naming the new host
  result.originMoved.servedBy;  // 'jina' | 'archive' | the render rung
}
```

This is what a sold or parked domain looks like: the redirect is refused, a fallback follows it from its own IPs, and the new owner's content comes back under your URL. An off-domain redirect is routinely a real migration, so the crawl succeeds, reports the move and leaves the decision with you. An ordinary crawl has no `originMoved`.

### Both lanes

```ts
const result = await crawler.crawl(target, url, { lanes: ['own', 'vendor'] });
```

The free lane runs first, and a paid vendor runs only when it cannot reach the page. A policy refusal, such as an off-domain redirect or a quarantine, never escalates, because paying to route around your own guard is no fallback.

## Crawling a site

`crawlSite` runs one request at a time unless you ask for more, and it never fetches a visited URL twice, so a "next page" link that loops back to page 1 ends the run. Its result lists `pages`, `notModified` (304 answers, never failures), `failures` (per URL, so one bad page never sinks the run) and `truncated` (it stopped at `maxPages` with URLs still queued).

### Cheap re-crawls

Origins that send ETag or Last-Modified answer a conditional GET with a 304, reported under `notModified`. For the rest, the content-region hash is compared and `unchanged` lists pages that downloaded but did not change. From `crawlSite`, pass `run.validators` back as `priorValidators`, or give it a `store` and it does this for you. From `crawl()`, send the page's `httpEtag` and `httpLastModified` as `etag` and `lastModified`. [LANES](LANES.md#making-re-crawls-cheap) explains both mechanisms.

### Site-wide change detection in one request

A sitemap's `<lastmod>` tells you which pages moved without fetching any of
them. Conditional GET answers the same question one request per page:

```ts
const run = await crawlSite(crawler, target, {
  useSitemap: true,
  priorLastmod: stored.lastmod,   // from last run
});

run.lastmod;           // { [url]: lastmod } — store for next time
run.skippedByLastmod;  // never fetched at all
```

Used only to **skip**. `<lastmod>` is origin-supplied and frequently a lie —
plenty of CMSs stamp every URL with today's date — so a *changed* value proves
nothing and simply lets the page through to the normal 304 and content-hash
checks, which are trustworthy. A page publishing no `<lastmod>` is always
crawled. Omit `priorLastmod` to disable entirely.

### Pages that need a click first

Some listings render their content only after a "Load more" button or an
infinite scroll. The first render is technically correct and practically
empty.

```ts
createCrawler({
  userAgent: 'MyBot/1.0 (+https://mysite.example/bot)',
  localRender: true,
  browserActions: [
    { type: 'click', selector: '.load-more' },
    { type: 'scroll', times: 3 },
    { type: 'wait', ms: 500 },
  ],
});
```

Runs on the local-render rung only. The bounds are library constants, not
options: at most 10 actions, 20 seconds total, 5 seconds per wait. A step that
fails is skipped and the run continues, because a missing "Load more" usually means
everything already loaded. The page's origin is re-checked after every step and
the run stops if it navigated away — a click can navigate, and continuing to
script a page that was never vetted would be a request forgery with a real
browser behind it.

**Never build these from crawled content.** An action derived from a page you
fetched lets that page script the browser that fetched it.

### Resuming a killed crawl

`crawlSite` keeps its queue in memory, so a 500-page run killed at page 400
restarts from zero unless you save its progress. The package stores nothing —
it hands you a snapshot and takes one back:

```ts
const run = await crawlSite(crawler, target, {
  followLinks: true,
  onProgress: (state) => myStore.save(target.baseUrl, state),  // plain JSON
});

// later, in a new process
await crawlSite(crawler, target, { followLinks: true, resumeFrom: myStore.load(target.baseUrl) });
```

Each snapshot covers every finished page, failed ones included, and the links they queued. `resumeFrom` replaces the seeds, and pages are not carried over, since you persisted them when you received them.

### Near-duplicate pages

Every page carries `contentSimhash`, a 64-bit fingerprint of its text as 16 hex
characters. `crawlSite` compares each page with the ones already collected in the run,
and a page within `nearDuplicateDistance` bits (default 3, about 95% similar text) lands
in `run.duplicates` as `{ url, of, distance }` and stays out of `run.pages`. A print view,
a tracking variant or a mirrored category path is reported once. Set
`nearDuplicateDistance: -1` to turn it off. Pages under 60 words get an empty fingerprint
and are never compared. Its links and validators are still used.

### Per-host stats

Every `crawlSite` result carries `hosts`, keyed by hostname, so a run says how each
origin behaved without extra tooling:

```ts
run.hosts['example.com'];
// { attempts, pages, failures: { transient, structural }, blockRate, medianLatencyMs }
```

`blockRate` is the share of attempts the origin answered with 403 or 429. A host whose
rate climbs needs a slower `minHostIntervalMs` or a different rung. Every `onUsage`
event also carries `host`, so spend and latency roll up per origin.

### Keeping a crawl's state in a store

`onProgress` and `resumeFrom` hand the state to your code. A `CrawlStore` lets `crawlSite`
do the round trip itself, so any worker can continue a crawl and every URL knows when it is due:

```ts
const store: CrawlStore = {
  load: (key) => db.get(key),        // CrawlState | null
  save: (key, state) => db.put(key, state),
};

await crawlSite(crawler, target, { followLinks: true, store });
```

The state is plain JSON: the unfinished queue, the validators, a recrawl schedule and each checked URL's sitemap date. A run continues an unfinished snapshot, and a finished run clears it. [LANES](LANES.md#making-re-crawls-cheap) explains the schedule, `run.notDue` and `run.skippedByLastmod`. A store that throws never stops the crawl, and saves are spaced `storeIntervalMs` apart (one second) with the final state always saved.

### Crawling in parallel

`crawlSite` fetches one page at a time unless you ask for more. Two options raise
that, and a third runs many sites together:

| Option | Default | Effect |
|---|---|---|
| `concurrency` | 1 | Pages in flight at once across the run |
| `perHostConcurrency` | 1 | Requests in flight to one host. Raise it only for an origin you operate |
| `siteConcurrency` | 4 | `crawlSites` only: sites crawled at once |

```ts
const runs = await crawlSites(crawler, targets, { followLinks: true, siteConcurrency: 8 });
```

The speed across a fleet comes from running different origins together, since each
site stays polite. The per-host limit is counted for the whole process, so two
targets on one origin share it. A snapshot taken mid-run puts the pages still in
flight back at the head of the queue, so a resume repeats them and loses none.

## Searching within a site (free)

`crawler.search()` asks a search engine, which always costs money. When you
already know the site and want its relevant pages, ask the site instead:

```ts
import { searchSite } from '@oliver/crawl-core';

const found = await searchSite(crawler, target, 'annual report');
found.urls;     // same-site result URLs
found.pattern;  // which query shape worked — pass back as knownPattern to skip probing
```

Free, and uncontroversial: submitting a query to a site's published search form
is ordinary use of the feature. It also reaches pages
neither link-following nor a sitemap will — an archived page reachable only
through search is exactly the kind a large site buries.

Results are read from the **main content region** of each page, so the
site's navigation does not come back as hits. Asset links are excluded.

It probes a handful of query shapes (`/?s=`, `/search?q=`, and a few others)
and reports which one worked. Many sites have no usable search; that returns
`ok: false` with a reason and never throws. It searches one known site, so
finding which sites exist still takes `crawler.search()`.

### Mapping a site without crawling it

`crawlSite` with `followLinks` has to FETCH every page to find the next one.
When you only need to know what exists, that is minutes and hundreds of
requests for something the site mostly already publishes:

```ts
import { mapSite } from '@oliver/crawl-core';

const map = await mapSite(crawler, target, { maxUrls: 500 });

map.feeds;    // ICS/RSS/Atom — usually the best targets on any site
map.urls;     // everything found
map.sources;  // { sitemap, feeds, homepageLinks } — why the result looks how it does
```

Exactly **one page body** is fetched: the homepage. Everything else comes from
listing documents. Cheap enough to run *before* deciding what a real crawl
should target, so `maxPages` becomes a budget you spend deliberately.

It is not a crawl — no recursion, no page content. Feed `map.urls` to
`crawlSite` as `seeds` when you want the content. A missing sitemap or an
unreachable homepage degrades to whichever source did answer and still
returns results.

### Discovering what to crawl (free)

```ts
// Simplest: let crawlSite find the pages itself.
const run = await crawlSite(crawler, target, { useSitemap: true, maxPages: 50 });

// Or discover explicitly:
const seeds = await crawler.discoverSeeds(target, 100);
```

Reads `/sitemap.xml` (following index files one level), filtered to same-site https URLs — a sitemap is origin-controlled content and gets no more trust than a page's own links. No sitemap falls back to `baseUrl`.

### Non-HTML documents

`page.contentKind` says which kind arrived, and only HTML fills the parsed fields:

| `contentKind` | From | `markdown`, `links`, `jsonLd` |
|---|---|---|
| `html` | text/html, xhtml | populated |
| `calendar` | text/calendar (`.ics`) | empty |
| `csv` | text/csv | empty |
| `json` | application/json, `+json` | empty |
| `feed` | RSS, Atom, generic XML | empty |
| `text` | text/plain | empty |
| `pdf` | application/pdf | empty |

Branch on `contentKind`, because `contentType` varies by server. On non-HTML kinds only `text` and `textSha256` carry meaning, and `markdown` and `contentRegionSha256` are empty, so a rung or kind change never looks like a content change. The injection guard runs on every kind, since a calendar feed is untrusted remote text like any page.

## Deciding what to do next

```ts
page.likelyEmptyState;  // loaded, but appears to say nothing
page.extractorVersion;  // which extractor produced this
```

`likelyEmptyState` flags pages that loaded and say nothing, such as "no results", "coming soon", parked domains and soft 404s. It is advisory, and the page is still returned in full, because an empty state is often a true fact worth recording.

`extractorVersion` lets an extraction improvement reach pages you already stored. Keep it beside the page, and re-process when it falls behind `EXTRACTOR_VERSION`.

`markdown` is empty on the text-only rungs (Jina and the vendors), so fall back to `text` when it is.
