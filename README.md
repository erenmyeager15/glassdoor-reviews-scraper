# Glassdoor Reviews Scraper & Employer Brand Monitor

Turn public Glassdoor employee reviews into employer-brand and employee-experience research for HR, recruiting and people-analytics teams. Export available ratings, pros, cons and employer replies, then reuse a named watchlist to identify newly observed reviews and company-rating changes.

No Glassdoor login, cookies, or API key is required.

## What makes this Actor useful

- **Available public review data:** overall and six category ratings, headline, pros, cons, advice, recommendation/CEO/outlook signals, job title, current/former status, employment type, tenure, location, date, helpful votes, review URL, and available employer replies. Missing source fields remain null rather than being invented.
- **Company rating snapshot:** overall rating, total review count, recommend-to-friend, CEO approval, business outlook, and available category ratings.
- **Recurring monitoring:** named watchlists label every row as `baseline`, `new`, or `seen` and preserve per-review first-seen time and observation count.
- **Only-new mode:** after the first baseline, emit only newly observed reviews to avoid duplicate dataset charges. Checking the source still uses resources even when there are no new reviews.
- **Change signals:** identify company-rating fields that changed since the previous complete observation.
- **Ready-to-use reports:** dataset JSON, formula-safe CSV, Markdown summary, company snapshots, and an honest run report.
- **Bounded access and gateway recovery:** one sessionless specialist Unblocker request per reviews API page. After an initial API HTTP 502/503/504, allow at most one public HTML recovery request per run on the same configured route. No Residential fallback or retry of denied/rate-limited access.
- **Safe partial results:** blocked or incomplete pages are reported as partial and are never treated as deleted reviews.

## Pricing: Saved Reviews + Actor Start

The Actor uses Pay Per Event pricing:

| Event | Price |
| --- | ---: |
| `review-scraped` | `$0.004` per successfully saved review, or `$4.00` per 1,000 |
| `apify-actor-start` | `$0.00005` per GB when the Actor starts, minimum one event |

Failed company requests and unsaved reviews do not trigger `review-scraped`. Reviews already saved before a partial failure retain their normal result charges. The Actor Start fee can still apply to empty or failed runs: Apify counts one start event per GB of memory, with at least one event. At the unchanged 256 MB default, that is `$0.00005` for the start event.

Platform usage is included under the current Store pricing. The monitoring reports have no separate report event. Check the [live Pricing tab](https://apify.com/fascinating_lentil/glassdoor-reviews-scraper/pricing) for current event prices, discounts and platform-usage terms before running. A saved-review subtotal is not the entire event bill: add the start fee.

## Quick start

Use a Glassdoor company Reviews URL:

```json
{
  "companyUrls": [
    "https://www.glassdoor.com/Reviews/Google-Reviews-E9079.htm"
  ],
  "maxReviewsPerCompany": 3,
  "watchlistName": "us-tech-employers",
  "onlyNewReviews": false
}
```

For recurring monitoring:

1. Run once with `onlyNewReviews: false` to create a baseline.
2. Save the input as an Apify Task.
3. Schedule the Task with the same `watchlistName`.
4. Turn on `onlyNewReviews` when you want later runs to emit only unseen reviews.

## Input

| Field | Purpose | Default |
|---|---|---:|
| `companyUrls` | Up to 20 Glassdoor company Reviews URLs | Google Reviews URL |
| `companyNames` | Optional company names to resolve | none |
| `maxReviewsPerCompany` | Maximum matching reviews saved per company | 3 |
| `filterByEmploymentStatus` | All, current, or former employees | all |
| `filterByJobTitle` | Case-insensitive job-title filter | none |
| `filterByLocation` | Case-insensitive location filter | none |
| `watchlistName` | Private key separating recurring monitors | `default` |
| `onlyNewReviews` | Emit only reviews unseen in earlier matching runs | `false` |
| `useUnblocker` | Use the recommended bounded anti-blocking route | `true` |
| `maxRunMinutes` | Stop new collection work near this limit | 5 |
| `proxyConfiguration` | Optional custom proxy override | automatic strategy |

Direct Glassdoor Reviews URLs are recommended when exact company matching matters.

## Review output

Each dataset row can include:

```json
{
  "companyName": "Example Co",
  "overallRating": 4,
  "ratingBand": "positive",
  "ratingWorkLifeBalance": 4,
  "ratingCultureAndValues": 5,
  "ratingDiversityAndInclusion": 4,
  "ratingSeniorLeadership": 3,
  "ratingCareerOpportunities": 4,
  "ratingCompensationAndBenefits": 5,
  "recommendToFriend": "POSITIVE",
  "ceoApproval": "APPROVE",
  "businessOutlook": "POSITIVE",
  "headline": "Supportive remote team",
  "pros": "Great culture and benefits.",
  "cons": "Some workload pressure.",
  "jobTitle": "Software Engineer",
  "employmentStatus": "Current Employee",
  "employmentType": "REGULAR",
  "employmentTenure": "4 years",
  "employmentTenureYears": 4,
  "location": "New York, NY",
  "reviewDate": "2026-10-10",
  "helpfulCount": 17,
  "topics": ["compensation", "culture", "remote-work", "workload"],
  "dataQualityWarnings": [],
  "monitoringStatus": "new",
  "firstObservedAt": "2026-10-11T00:00:00.000Z",
  "observationCount": 1,
  "companyChangeDetected": true,
  "companyChangedFields": ["overallRating", "totalReviewsCount"],
  "sourceQuality": "complete"
}
```

Topic labels are transparent keyword signals, not AI sentiment scores. `ratingBand` is deterministic: 4–5 positive, 3–3.9 mixed, below 3 negative.

## Saved outputs

- **Default dataset:** review rows.
- **`COMPANIES`:** company rating snapshots.
- **`MONITORING-REPORT`:** per-company coverage and change evidence.
- **`MONITORING-REPORT.md`:** readable monitoring summary.
- **`MONITORING-REPORT.csv`:** spreadsheet-ready review export with formula-injection protection.
- **`OUTPUT`:** run status, completed and failed company counts, budget status, and concise failure reasons.

## Reliability and cost controls

The Actor uses lightweight HTTP rather than a full browser. The default memory is 256 MB, the automated-test input requests only three reviews, and work is bounded by company, page, response-size, request-time, and total-run limits.

The automatic strategy normally makes one sessionless Unblocker request per reviews API page. If the first API page fails with a typed HTTP 502/503/504 gateway response, it may fetch one public reviews HTML page on the same route, at most once per run. This is not a repeated API POST, a change of proxy provider, or an unlimited fallback. The extra successful request may incur another Unblocker charge. It is subject to the remaining time and result budget. Source denial/challenge, HTTP 401/403/407/412/429/451, authentication errors, parsing errors and request timeouts do not trigger this recovery. A failed proxy initialization fails closed instead of silently switching to direct access. An explicit `proxyConfiguration` still selects the route; only its Unblocker variant enables this narrow managed gateway recovery.

Recovery accepts only the requested employer's supported reviews URL and usable review content. A client shell, login redirect or empty review card cannot become a successful paid result. One recovery page can yield a smaller sample; partial coverage holds the monitoring baseline. JSON reports disclose `gatewayRecovery`, `gatewayRecoveriesAttempted` and `gatewayRecoveriesSucceeded`, including the original gateway status. HTML fields not present on the source remain null.

Remaining review charges are checked before access setup, company resolution, collection and each dataset push. An exhausted limit is reported as `BUDGET_LIMITED`; it is not called an access block. A smaller affordable sample is explicitly partial and cannot overwrite a complete monitoring baseline. Startup/report storage costs can still apply.

Readable earlier pages are retained if a later page fails, with partial coverage and no monitoring-baseline update. Repeated pages, failed history writes and unresolved company names are not labeled `COMPLETE`. CSV and other report exports must succeed before history advances; an error after a history write reports confirmed commits rather than claiming rollback. `OUTPUT` separates output-billing/report failures from source failures and preserves the count of reviews actually saved.

Each request also respects the remaining total-run time. The run report distinguishes completed companies from unattempted companies. Source access failures remain visible; a total block never becomes a fabricated empty success.

The sessionless Unblocker request window is at most 75 seconds, shortened when the collection deadline is nearer. A conditional single gateway-recovery page uses that same remaining deadline, without retry loops or a Residential fallback. Ordinary direct/custom routes retain their existing request limits. Total source failure still fails honestly with no fabricated rows; changing an example or marking an empty run successful is not a repair.

The Unblocker connection accepts the proxy's interception certificate only for that managed route; ordinary direct connections retain normal TLS verification.

## Limits

Glassdoor can change its public pages or block access. A run can therefore return partial results or fail for a company. The Actor reports that condition instead of fabricating data or silently claiming completion. Filters may require reading additional public pages before enough matching reviews are found.

This Actor reads public information only. Use the data lawfully, respect applicable privacy and employment laws, and do not use it to make automated decisions about individual employees or job applicants.
