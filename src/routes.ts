import { PlaywrightCrawlingContext } from 'crawlee';
import { Actor, log as defaultLog } from 'apify';
import type { ActorInput, CompanyRecord, ReviewRecord } from './types.js';

interface RequestUserData {
    label: 'COMPANY' | 'SEARCH';
    companyName?: string;
    companyUrl?: string;
    pageNum?: number;
    collectedIds?: string[];
    maxReviews?: number;
    filterByEmploymentStatus?: string;
    filterByJobTitle?: string;
    filterByLocation?: string;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Glassdoor is fronted by a Cloudflare managed challenge. A real (headed/xvfb) browser
 * clears it automatically, but it can take a few seconds and occasionally needs a reload.
 * Returns true once the real page (review cards or normal title) is visible.
 */
async function clearCloudflare(page: PlaywrightCrawlingContext['page'], log = defaultLog): Promise<boolean> {
    const challengeRe = /just a moment|attention required|security \| glassdoor|checking your browser/i;
    const deadline = Date.now() + 55000;
    let reloads = 0;

    while (Date.now() < deadline) {
        const cleared = await page
            .waitForFunction(
                () => {
                    const t = document.title || '';
                    if (/just a moment|attention required|security \| glassdoor|checking your browser/i.test(t)) return false;
                    return !!document.querySelector('article[data-test="review-detail"], [data-test="rating-headline"], h1');
                },
                { timeout: 8000 },
            )
            .then(() => true)
            .catch(() => false);

        if (cleared) {
            const title = await page.title().catch(() => '');
            if (!challengeRe.test(title)) return true;
        }

        // Still challenged - give the challenge JS a moment, then reload once or twice.
        await delay(3000);
        if (reloads < 2 && Date.now() < deadline - 8000) {
            reloads++;
            log.info(`Cloudflare challenge still up, reloading (attempt ${reloads})...`);
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => null);
        }
    }
    const finalTitle = await page.title().catch(() => '');
    return !challengeRe.test(finalTitle) && !!(await page.$('article[data-test="review-detail"]'));
}

/** Build the Glassdoor reviews URL for a given page number (inserts _P{n} before .htm). */
function pageUrl(baseUrl: string, pageNum: number): string {
    const clean = baseUrl.split('#')[0].replace(/_P\d+\.htm/i, '.htm');
    if (pageNum <= 1) return clean;
    return clean.replace(/\.htm(\?|$)/i, `_P${pageNum}.htm$1`);
}

function extractCompany(rawName: string, rawRating: number | null, recommend: number | null, ceo: number | null, total: number | null, url: string): CompanyRecord {
    return {
        companyName: (rawName || '').replace(/\s*Reviews\s*$/i, '').trim() || rawName,
        glassdoorUrl: url,
        overallRating: rawRating,
        recommendToFriendPct: recommend,
        ceoApprovalPct: ceo,
        totalReviewsCount: total,
        scrapedAt: new Date().toISOString(),
    };
}

export function buildHandler(input: ActorInput) {
    const rawMax = input.maxReviewsPerCompany ?? 100;
    const maxReviews = rawMax === 0 ? Number.POSITIVE_INFINITY : rawMax;
    const fStatus = (input.filterByEmploymentStatus || '').toLowerCase();
    const fTitle = (input.filterByJobTitle || '').toLowerCase();
    const fLoc = (input.filterByLocation || '').toLowerCase();

    return async (context: PlaywrightCrawlingContext): Promise<void> => {
        const { page, request, log, session, crawler } = context;
        const userData = request.userData as RequestUserData;

        const cleared = await clearCloudflare(page, log);
        if (!cleared) {
            session?.markBad();
            throw new Error(`Cloudflare challenge did not clear for ${request.url}. Retrying with a new session.`);
        }

        // --- SEARCH: resolve a company name to its reviews URL ---
        if (userData.label === 'SEARCH') {
            const href = await page.evaluate(() => {
                const a = document.querySelector(
                    'a[href*="-Reviews-E"], a[data-test="company-tile"], .companyOverviewLink',
                ) as HTMLAnchorElement | null;
                return a?.getAttribute('href') || null;
            });
            if (!href) {
                log.warning(`No company found for search "${userData.companyName}". Provide a direct Glassdoor reviews URL instead.`);
                return;
            }
            const full = href.startsWith('http') ? href : `https://www.glassdoor.com${href.startsWith('/') ? '' : '/'}${href}`;
            await crawler.addRequests([
                {
                    url: full,
                    userData: { ...userData, label: 'COMPANY', companyUrl: full, pageNum: 1, collectedIds: [] },
                },
            ]);
            return;
        }

        // --- COMPANY: extract company header (page 1 only) + reviews on this page ---
        const pageNum = userData.pageNum ?? 1;
        const collectedIds = userData.collectedIds ?? [];

        if (pageNum === 1) {
            const header = await page.evaluate(() => {
                const txt = (sel: string) => document.querySelector(sel)?.textContent?.trim() || '';
                const num = (s: string) => {
                    const m = s.match(/(\d+(?:\.\d+)?)/);
                    return m ? parseFloat(m[1]) : null;
                };
                const name = txt('h1');
                const rating = num(txt('[data-test="rating-headline"]'));
                const recommend = num(txt('[data-test="recommendToFriend"]'));
                const ceo = num(txt('[data-test="ceo-overview"] [data-test="ceoApprovalRating"], [data-test="ceo-overview"]'));
                let total: number | null = null;
                const rc = document.querySelector('[data-test="ei-review-count"], [data-test="reviewCount"]')?.textContent || '';
                const rcm = rc.replace(/[, ]/g, '').match(/(\d+)/);
                if (rcm) total = parseInt(rcm[1], 10);
                return { name, rating, recommend, ceo, total };
            });

            const companyRecord = extractCompany(
                header.name,
                header.rating,
                header.recommend,
                header.ceo,
                header.total,
                request.url,
            );
            const companyDataset = await Actor.openDataset('companies');
            await companyDataset.pushData(companyRecord);
            userData.companyName = companyRecord.companyName;
            log.info(`Company: ${companyRecord.companyName} | rating ${companyRecord.overallRating ?? 'n/a'}`);
        }

        const companyName = userData.companyName || '';
        const reviews = await page.evaluate(() => {
            const cards = [...document.querySelectorAll('article[data-test="review-detail"]')];
            const t = (el: Element | null) => el?.textContent?.trim() || null;
            return cards.map((card) => {
                const brand = card.getAttribute('data-brandviews') || '';
                const idM = brand.match(/review_id=(\d+)/);
                const linkEl = card.querySelector('a[href*="Employee-Review-"]') as HTMLAnchorElement | null;
                const href = linkEl?.getAttribute('href') || null;
                let reviewId = idM ? idM[1] : '';
                if (!reviewId && href) {
                    const hm = href.match(/RVW(\d+)/);
                    if (hm) reviewId = hm[1];
                }

                const ratingTxt = t(card.querySelector('[data-test="review-rating-label"]'));
                const overallRating = ratingTxt ? parseFloat(ratingTxt) : null;

                const headline = t(card.querySelector('a[href*="Employee-Review-"] h3, h3'));
                const jobTitle = t(card.querySelector('[data-test="content-avatar-label"]'));

                const tags = [...card.querySelectorAll('[data-test="content-avatar-tag"]')].map((e) => e.textContent?.trim() || '');
                let employmentStatus: string | null = null;
                let employmentTenure: string | null = null;
                let location: string | null = null;
                for (const tag of tags) {
                    const low = tag.toLowerCase();
                    if (/current employee|former employee/.test(low)) {
                        // Status and tenure are sometimes combined: "Current employee, more than 1 year".
                        const parts = tag.split(',');
                        employmentStatus = parts[0].trim();
                        if (parts.length > 1) employmentTenure = parts.slice(1).join(',').trim();
                    } else if (/year|month|less than|more than/.test(low)) {
                        employmentTenure = tag;
                    } else if (tag) {
                        location = tag;
                    }
                }

                const pros = t(card.querySelector('[data-test="review-text-PROS"]'));
                const cons = t(card.querySelector('[data-test="review-text-CONS"]'));
                const reviewDate = t(card.querySelector('[class*="Timestamp_reviewDate"], time'));

                return { reviewId, href, overallRating, headline, jobTitle, employmentStatus, employmentTenure, location, pros, cons, reviewDate };
            });
        });

        log.info(`Found ${reviews.length} review cards on page ${pageNum}`);

        let newCount = 0;
        for (const r of reviews) {
            if (!r.reviewId || collectedIds.includes(r.reviewId)) continue;
            if (collectedIds.length >= maxReviews) break;

            // Client-side filters
            if (fStatus && r.employmentStatus && !r.employmentStatus.toLowerCase().includes(fStatus)) continue;
            if (fTitle && r.jobTitle && !r.jobTitle.toLowerCase().includes(fTitle)) continue;
            if (fLoc && r.location && !r.location.toLowerCase().includes(fLoc)) continue;

            const record: ReviewRecord = {
                companyName,
                companyUrl: userData.companyUrl || request.url,
                reviewId: r.reviewId,
                reviewUrl: r.href ? (r.href.startsWith('http') ? r.href : `https://www.glassdoor.com${r.href}`) : null,
                headline: r.headline,
                overallRating: r.overallRating,
                jobTitle: r.jobTitle,
                employmentStatus: r.employmentStatus,
                employmentTenure: r.employmentTenure,
                location: r.location,
                reviewDate: r.reviewDate,
                pros: r.pros,
                cons: r.cons,
                scrapedAt: new Date().toISOString(),
            };

            collectedIds.push(r.reviewId);
            await Actor.pushData(record);
            await Actor.charge({ eventName: 'review-scraped' }).catch(() => null);
            newCount++;
        }

        log.info(`Pushed ${newCount} new reviews (total ${collectedIds.length}/${maxReviews === Number.POSITIVE_INFINITY ? 'all' : maxReviews}) for ${companyName}`);

        // Pagination: stop if we hit the cap, found no new reviews, or no review cards at all.
        if (collectedIds.length >= maxReviews || newCount === 0 || reviews.length === 0) return;

        const nextUrl = pageUrl(userData.companyUrl || request.url, pageNum + 1);
        await crawler.addRequests([
            {
                url: nextUrl,
                uniqueKey: `${userData.companyUrl || request.url}#P${pageNum + 1}`,
                userData: { ...userData, label: 'COMPANY', pageNum: pageNum + 1, collectedIds },
            },
        ]);
    };
}
