# Glassdoor Reviews Scraper & Employer Brand Monitor

Extract public Glassdoor employee reviews and company ratings, then run the same watchlist on a schedule to identify newly observed reviews and employer-brand changes.

No Glassdoor login, cookies, or API key is required.

## What makes this Actor useful

- **Complete review data:** overall and six category ratings, headline, pros, cons, advice, recommendation/CEO/outlook signals, job title, current/former status, employment type, tenure, location, date, helpful votes, review URL, and available employer replies.
- **Company rating snapshot:** overall rating, total review count, recommend-to-friend, CEO approval, business outlook, and available category ratings.
- **Recurring monitoring:** named watchlists label every row as `baseline`, `new`, or `seen` and preserve per-review first-seen time and observation count.
- **Only-new mode:** after the first baseline, emit only newly observed reviews so scheduled runs stay focused and inexpensive.
- **Change signals:** identify company-rating fields that changed since the previous complete observation.
- **Ready-to-use reports:** dataset JSON, formula-safe CSV, Markdown summary, company snapshots, and an honest run report.
- **Reliable bounded access:** one sessionless specialist Unblocker request per reviews API page replaces the direct, datacenter, and Residential routes that Glassdoor blocked in live tests.
- **Safe partial results:** blocked or incomplete pages are reported as partial and are never treated as deleted reviews.

## Pricing

The Actor charges **$4 per 1,000 successfully saved reviews** (`$0.004` per review). Failed companies and unsaved reviews are not charged. Platform usage is included in the event price shown by Apify.

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

The automatic strategy makes one sessionless Unblocker request per reviews API page. It does not repeat a premium request through an HTML fallback. If you provide `proxyConfiguration`, that explicit choice replaces the automatic strategy.

The Unblocker connection accepts the proxy's interception certificate only for that managed route; ordinary direct connections retain normal TLS verification.

## Limits

Glassdoor can change its public pages or block access. A run can therefore return partial results or fail for a company. The Actor reports that condition instead of fabricating data or silently claiming completion. Filters may require reading additional public pages before enough matching reviews are found.

This Actor reads public information only. Use the data lawfully, respect applicable privacy and employment laws, and do not use it to make automated decisions about individual employees or job applicants.
