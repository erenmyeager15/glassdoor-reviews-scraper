# Glassdoor Reviews Scraper - Resume Notes (PARKED)

**Status:** Parked. Build is correct and works for page 1, but Glassdoor cannot be reliably
scraped at depth without a paid Cloudflare unblocker + a logged-in Glassdoor session.

## What works
- A headed browser (xvfb on Apify) **can** clear Glassdoor's Cloudflare managed challenge,
  but only intermittently on free residential proxies (usually needs 1-2 session retries).
- Once cleared, page 1 extracts cleanly:
  - Company summary: name, overall rating, recommend-to-friend %, CEO approval %
    (saved to the key-value store as `company-<name>`).
  - The publicly visible reviews on page 1 (≈3-10 depending on company) with full fields:
    reviewId, reviewUrl, headline, rating, jobTitle, employmentStatus, tenure, location,
    date, pros, cons (parsed from `article[data-test="review-detail"]` cards).

Verified locally and on Apify: `Company: Google | rating 4.4` → `Found 3 review cards` →
`Pushed 3 new reviews`.

## What blocks it
1. **Login wall on pagination.** Glassdoor only serves the first review page to anonymous
   users. Page 2+ (`..._P2.htm`) requires a logged-in account; without cookies it returns a
   Cloudflare/login wall and never yields reviews. Pagination is therefore **disabled** in
   `src/routes.ts` (so runs don't waste credits spinning on walled pages).
2. **Cloudflare is enterprise-grade and flaky.** Even page 1 needs session retries, and
   deeper pages never cleared across 7+ retries on residential. This is the same tier as the
   parked Crunchbase actor.

## What it needs to ship for real
- **Glassdoor login cookies** (a valid `GDSession` / auth cookie set) passed via input, applied
  to the browser context before navigation → unlocks full review pagination.
- **A paid Cloudflare unblocker** (e.g. Apify's anti-blocking browser / a commercial unblock
  API) for reliable challenge solving instead of the flaky headed-xvfb approach.
- Then: re-enable pagination in `src/routes.ts` (the `pageUrl()` helper + the removed
  `crawler.addRequests` block — see the `void pageUrl; void crawler;` marker), bump
  `maxRequestRetries`, and test.

## Current safe behavior
- `headless: false` (xvfb), residential US proxy, `maxRequestRetries: 3`.
- Pagination disabled: scrapes company summary + page-1 public reviews only, then stops.
- PAY_PER_EVENT `review-scraped` @ $0.004; only charges for reviews actually extracted.

## Files
- `src/main.ts` - crawler config (headed, residential US, low retries)
- `src/routes.ts` - `clearCloudflare()` + review-card extraction; pagination disabled
- `.actor/actor.json` - PAY_PER_EVENT pricing, dataset view, categories
- `INPUT_SCHEMA.json` - inputs (companyUrls / companyNames / filters / proxy)
