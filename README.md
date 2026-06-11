# Glassdoor Reviews Scraper - Ratings, Pros & Cons

Scrape **Glassdoor company reviews** from public company review pages. Anonymous runs collect the public first page; add your own Glassdoor cookies to enable authenticated pagination across deeper review pages. Extract employee ratings, review headlines, pros, cons, job titles, employment status, tenure, location, and dates from any company's Glassdoor page. Export results to JSON, CSV, Excel, or HTML, or pull them through the Apify API.

Perfect for employer branding, HR benchmarking, competitor research, sentiment analysis, and job-market intelligence.

## Features

- Works anonymously for public page-1 reviews
- Optional Glassdoor cookies for authenticated pagination
- Handles Glassdoor's anti-bot protection with a real browser and residential proxy support
- Multiple companies per run - pass a list of URLs or company names
- Complete review data - rating, headline, pros, cons, job title, status, tenure, location, date
- Company insights - overall rating, recommend-to-friend %, CEO approval %
- Filter by employment status, job title, or location
- Automatic pagination when authenticated cookies are provided
- Clean structured output - ready for spreadsheets, BI tools, or NLP pipelines

## What It Extracts

### Company record

Company records are saved to the key-value store as `company-<name>`.

- Company name and Glassdoor URL
- Overall rating
- Recommend-to-friend %
- CEO approval %
- Total review count when visible

### Review record

Review records are saved to the default dataset.

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
| `maxReviewsPerCompany` | `integer` | Max reviews per company (`0` = all available to the session) | `10` |
| `glassdoorCookies` | `string` | Optional secret Cookie header or JSON cookie array for authenticated pagination | empty |
| `filterByEmploymentStatus` | `string` | `current`, `former`, or all | all |
| `filterByJobTitle` | `string` | Keep reviews whose job title contains this text | all |
| `filterByLocation` | `string` | Keep reviews whose location contains this text | all |
| `proxyConfiguration` | `object` | Proxy settings (residential strongly recommended) | Apify Residential |

### Example input

```json
{
    "companyUrls": ["https://www.glassdoor.com/Reviews/Google-Reviews-E9079.htm"],
    "maxReviewsPerCompany": 10,
    "filterByEmploymentStatus": "current",
    "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

### Authenticated Pagination

To scrape page 2 and beyond, paste your own logged-in Glassdoor cookies into `glassdoorCookies`.

The actor accepts either:

- Browser Cookie header format: `name=value; name2=value2`
- JSON cookie array exported from your browser

## Sample Output

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
    "totalReviewsCount": 10000,
    "scrapedAt": "2026-06-10T18:38:03.106Z"
}
```

## Pricing

This Actor uses pay-per-result pricing:

| Event | Price |
|-------|-------|
| Per review scraped | **$0.004** ($4 / 1,000 reviews) |

You are only charged for reviews actually extracted - never for blocked or empty runs. Apify platform usage and proxy traffic are billed separately by Apify.

## Use Cases

- Employer branding - monitor how employees rate your company
- HR benchmarking - compare ratings, pros, and cons against competitors
- Sentiment analysis and NLP - feed clean review text into ML pipelines
- Job-market intelligence - understand culture, management, and work-life balance trends
- Competitor research - track rival employers' reputation over time

## Tips

- Glassdoor uses Cloudflare protection - keep residential proxies enabled for reliable results.
- Direct Glassdoor reviews-page URLs are more reliable than company-name search.
- Without `glassdoorCookies`, Glassdoor usually exposes only page 1 of reviews. Add authenticated cookies for deeper pagination.

## License

Apache-2.0
