# Glassdoor Reviews Scraper - Ratings, Pros & Cons

Scrape **Glassdoor company reviews** at scale - no login, no API key, no cookies required. Extract employee ratings, review headlines, pros, cons, job titles, employment status, tenure, location, and dates from any company's Glassdoor page. Export results to **JSON, CSV, Excel, or HTML**, or pull them through the Apify API.

Perfect for **employer branding, HR benchmarking, competitor research, sentiment analysis, and job-market intelligence**.

## Features

- ✅ **No login or API key** - works out of the box
- ✅ **Solves Glassdoor's anti-bot protection** automatically with a real browser
- ✅ **Multiple companies per run** - pass a list of URLs or company names
- ✅ **Complete review data** - rating, headline, pros, cons, job title, status, tenure, location, date
- ✅ **Company insights** - overall rating, recommend-to-friend %, CEO approval %
- ✅ **Filter** by employment status, job title, or location
- ✅ **Automatic pagination** across review pages
- ✅ **Clean structured output** - ready for spreadsheets, BI tools, or NLP pipelines

## What it extracts

### Company record (saved to the key-value store as `company-<name>`)
- Company name and Glassdoor URL
- Overall rating
- Recommend-to-friend %
- CEO approval %

### Review record (default dataset)
- Review ID and direct review URL
- Overall star rating and headline
- Pros and cons text
- Job title, employment status, tenure, and location
- Review date

## Input

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `companyUrls` | `string[]` | Glassdoor reviews-page URLs (recommended) | Google example |
| `companyNames` | `string[]` | Company names to search on Glassdoor | `[]` |
| `maxReviewsPerCompany` | `integer` | Max reviews per company (`0` = all public) | `50` |
| `filterByEmploymentStatus` | `string` | `current`, `former`, or all | all |
| `filterByJobTitle` | `string` | Keep reviews whose job title contains this text | all |
| `filterByLocation` | `string` | Keep reviews whose location contains this text | all |
| `proxyConfiguration` | `object` | Proxy settings (residential strongly recommended) | Apify Residential |

### Example input

```json
{
    "companyUrls": ["https://www.glassdoor.com/Reviews/Google-Reviews-E9079.htm"],
    "maxReviewsPerCompany": 100,
    "filterByEmploymentStatus": "current",
    "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

## Sample output

### Review

```json
{
    "companyName": "Google",
    "companyUrl": "https://www.glassdoor.com/Reviews/Google-Reviews-E9079.htm",
    "reviewId": "104309026",
    "reviewUrl": "https://www.glassdoor.com/Reviews/Employee-Review-Google-E9079-RVW104309026.htm",
    "headline": "Good for tech research, but slow growth response",
    "overallRating": 4,
    "jobTitle": "Hardware engineer",
    "employmentStatus": "Current employee",
    "employmentTenure": "more than 1 year",
    "location": "Fremont, CA",
    "reviewDate": "8 Jun 2026",
    "pros": "Good for tech research and innovation goals.",
    "cons": "Bad for the quick response and growth.",
    "scrapedAt": "2026-06-10T18:38:03.132Z"
}
```

### Company

```json
{
    "companyName": "Google",
    "glassdoorUrl": "https://www.glassdoor.com/Reviews/Google-Reviews-E9079.htm",
    "overallRating": 4.4,
    "recommendToFriendPct": 87,
    "ceoApprovalPct": 82,
    "scrapedAt": "2026-06-10T18:38:03.106Z"
}
```

## Pricing

This Actor uses **pay-per-result** pricing:

| Event | Price |
|-------|-------|
| Per review scraped | **$0.004** ($4 / 1,000 reviews) |

You are only charged for reviews actually extracted - never for blocked or empty runs. Apify platform usage and proxy traffic are billed separately by Apify.

## Use cases

- **Employer branding** - monitor how employees rate your company
- **HR benchmarking** - compare ratings, pros, and cons against competitors
- **Sentiment analysis & NLP** - feed clean review text into ML pipelines
- **Job-market intelligence** - understand culture, management, and work-life balance trends
- **Competitor research** - track rival employers' reputation over time

## Tips

- Glassdoor uses Cloudflare protection - keep **residential proxies** enabled for reliable results.
- Direct Glassdoor reviews-page URLs are more reliable than company-name search.
- Glassdoor limits how many reviews are visible without an account, so very large companies may return their most recent public reviews.

## License

Apache-2.0
