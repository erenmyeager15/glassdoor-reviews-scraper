# Glassdoor Reviews Scraper - Resume Notes

## Status

Fixed for the realistic Glassdoor constraint:

- Anonymous runs scrape the public first review page and stop safely.
- Authenticated runs can paginate page 2+ when the user supplies valid Glassdoor cookies in `glassdoorCookies`.
- The actor no longer advertises impossible anonymous deep pagination.

## What works

- Company summary is saved to the key-value store as `company-<name>`.
- Review records are saved to the default dataset.
- PAY_PER_EVENT `review-scraped` @ `$0.004`; charging happens only after a review is pushed.
- Cloudflare challenge handling is still browser-based with headed Chrome and residential proxy support.
- Cookie input accepts either:
  - Browser Cookie header format: `name=value; name2=value2`
  - JSON cookie array exported from a browser

## Current behavior

- No `glassdoorCookies`: scrape page 1 only, then log that pagination was skipped.
- With `glassdoorCookies`: inject cookies before navigation and queue `_P2`, `_P3`, etc. until:
  - requested max reviews is reached,
  - a page returns zero new reviews,
  - the crawler fails due to expired cookies / Cloudflare.

## Remaining risk

Glassdoor is still protected by enterprise-grade Cloudflare. Expired cookies, weak proxies, or stricter challenge variants can still block runs. For best reliability on Apify, use residential proxy and fresh logged-in cookies.
