import { load } from 'cheerio';
import type { CompanySummary, ParsedReviewPage, RatingBand, ReviewRecord } from './types.js';

type BaseReview = ParsedReviewPage['reviews'][number];

export function normalizeText(value: unknown): string {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function nullableText(value: unknown): string | null {
    const normalized = normalizeText(value);
    return normalized || null;
}

export function parseCompactNumber(value: unknown): number | null {
    const text = normalizeText(value).replace(/,/g, '');
    const match = text.match(/(-?\d+(?:\.\d+)?)\s*([KMB])?/i);
    if (!match) return null;
    const multipliers: Record<string, number> = { K: 1_000, M: 1_000_000, B: 1_000_000_000 };
    const number = Number(match[1]) * (multipliers[(match[2] ?? '').toUpperCase()] ?? 1);
    return Number.isFinite(number) ? number : null;
}

function clampPercentage(value: unknown): number | null {
    const parsed = parseCompactNumber(value);
    return parsed !== null && parsed >= 0 && parsed <= 100 ? parsed : null;
}

export function ratingBand(rating: number | null): RatingBand {
    if (rating === null || !Number.isFinite(rating)) return 'unknown';
    if (rating >= 4) return 'positive';
    if (rating >= 3) return 'mixed';
    return 'negative';
}

function reviewRating(value: unknown): number | null {
    const rating = parseCompactNumber(value);
    return rating !== null && rating >= 1 && rating <= 5 ? rating : null;
}

function tenureYears(value: unknown): number | null {
    if (typeof value === 'string' && !/^\s*\d+\s*$/.test(value)) return null;
    const parsed = parseCompactNumber(value);
    return parsed !== null && parsed >= 0 && Number.isInteger(parsed) ? parsed : null;
}

function tenureLabel(years: number | null): string | null {
    if (years === null) return null;
    if (years === 0) return 'Less than 1 year';
    return `${years} ${years === 1 ? 'year' : 'years'}`;
}

function formattedTenure(value: unknown, years: number | null): string | null {
    const numeric = tenureLabel(years);
    if (numeric) return numeric;
    const text = normalizeText(value);
    if (!text) return null;
    return text.toLowerCase().replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function dataWarnings(jobTitle: string | null): string[] {
    return jobTitle && /,\s*[A-Z]{2}$/i.test(jobTitle) ? ['jobTitleLooksLikeLocation'] : [];
}

const TOPIC_PATTERNS: Array<[string, RegExp]> = [
    ['compensation', /\b(pay|salary|compensation|bonus|benefits?)\b/i],
    ['work-life-balance', /\b(work[ -]?life|long hours|overtime|burnout|burned out)\b/i],
    ['management', /\b(manager|management|leadership|supervisor)\b/i],
    ['career-growth', /\b(promotion|career|growth|learning|training|advancement)\b/i],
    ['culture', /\b(culture|colleagues?|coworkers?|team|people)\b/i],
    ['job-security', /\b(layoffs?|reorgani[sz]ation|job security|pip)\b/i],
    ['remote-work', /\b(remote|hybrid|work from home|wfh)\b/i],
    ['workload', /\b(workload|pressure|stress|demanding|overworked)\b/i],
];

export function detectTopics(...values: Array<string | null | undefined>): string[] {
    const text = values.filter(Boolean).join(' ');
    return TOPIC_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic);
}

export function employerIdFromUrl(url: string): number | null {
    const match = url.match(/-E(\d+)(?:_P\d+)?\.htm/i);
    return match ? Number(match[1]) : null;
}

export function companyNameFromUrl(url: string): string {
    try {
        const path = new URL(url).pathname;
        const match = path.match(/\/Reviews\/(.+?)-Reviews-E\d+/i);
        return match ? decodeURIComponent(match[1]).replace(/-/g, ' ') : '';
    } catch {
        return '';
    }
}

export function reviewPageUrl(baseUrl: string, page: number): string {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/_P\d+(?=\.htm$)/i, '');
    if (page > 1) url.pathname = url.pathname.replace(/\.htm$/i, `_P${page}.htm`);
    return url.toString();
}

function absoluteGlassdoorUrl(value: string | null, baseUrl: string): string | null {
    if (!value) return null;
    try {
        const resolved = new URL(value, baseUrl);
        return resolved.protocol === 'https:' && /(^|\.)glassdoor\./i.test(resolved.hostname) ? resolved.toString() : null;
    } catch {
        return null;
    }
}

export function isBlockedGlassdoorPage(statusCode: number, html: string): boolean {
    if ([401, 403, 429].includes(statusCode)) return true;
    const sample = html.slice(0, 80_000);
    return /<title>\s*(?:Security \| Glassdoor|Just a moment)/i.test(sample)
        || /\bHumans only\b|Enable JavaScript and cookies to continue|cf-chl-/i.test(sample);
}

export function hasUsableReviewPage(html: string): boolean {
    return /data-test=["']review-detail["']/i.test(html)
        || /"employerReviews"\s*:/i.test(html)
        || /\bViewing\s+\d+\s*-\s*\d+\s+of\s+[\d,]+\s+Reviews\b/i.test(html);
}

function parsePageNumber(url: string): number {
    const match = url.match(/_P(\d+)\.htm/i);
    return match ? Number(match[1]) : 1;
}

function reviewIdFromCard(attributes: Record<string, string | undefined>, href: string | null): string {
    const brand = attributes['data-brandviews'] ?? '';
    return brand.match(/review_id=(\d+)/)?.[1] ?? href?.match(/RVW(\d+)/i)?.[1] ?? '';
}

export function parseHtmlReviewPage(html: string, sourceUrl: string, scrapedAt = new Date().toISOString()): ParsedReviewPage {
    const $ = load(html);
    const firstText = (...selectors: string[]): string => {
        for (const selector of selectors) {
            const value = normalizeText($(selector).first().text());
            if (value) return value;
        }
        return '';
    };
    const name = firstText('h1').replace(/\s+reviews?\s*$/i, '') || companyNameFromUrl(sourceUrl);
    const totalText = firstText('[data-test="ei-review-count"]', '[data-test="reviewCount"]');
    const body = normalizeText($('body').text());
    const totalFromBody = body.match(/([\d,.]+[KMB]?)\s+total reviews?/i)?.[1]
        ?? body.match(/Viewing\s+\d+\s*-\s*\d+\s+of\s+([\d,]+)\s+Reviews/i)?.[1];
    const pageCountText = $('a[href*="_P"]').toArray()
        .map((element) => Number(normalizeText($(element).text()).replace(/,/g, '')))
        .filter((value) => Number.isInteger(value));
    const ratingCategories: Record<string, number> = {};
    $('[data-test*="rating-category"], [data-test*="ratingCategory"]').each((_index, element) => {
        const text = normalizeText($(element).text());
        const match = text.match(/^(\d(?:\.\d)?)\s+(.+)$/);
        if (match) ratingCategories[match[2].toLowerCase().replace(/[^a-z0-9]+/g, '-')] = Number(match[1]);
    });

    const summary: CompanySummary = {
        employerId: employerIdFromUrl(sourceUrl),
        companyName: name,
        glassdoorUrl: reviewPageUrl(sourceUrl, 1),
        overallRating: parseCompactNumber(firstText('[data-test="rating-headline"]', '[data-test="rating-info"]')),
        recommendToFriendPct: clampPercentage(firstText('[data-test="recommendToFriend"]'))
            ?? clampPercentage(body.match(/(\d+(?:\.\d+)?)% would recommend to a friend/i)?.[1]),
        ceoApprovalPct: clampPercentage(firstText('[data-test="ceoApprovalRating"]', '[data-test="ceo-overview"]'))
            ?? clampPercentage(body.match(/(\d+(?:\.\d+)?)% approve of CEO/i)?.[1]),
        businessOutlookPct: clampPercentage(body.match(/(\d+(?:\.\d+)?)% positive business outlook/i)?.[1]),
        totalReviewsCount: parseCompactNumber(totalText || totalFromBody),
        ratingCategories,
        scrapedAt,
    };

    const reviews: BaseReview[] = [];
    $('article[data-test="review-detail"], div[data-test="review-detail"]').each((_index, card) => {
        const root = $(card);
        const text = (...selectors: string[]): string | null => {
            for (const selector of selectors) {
                const value = nullableText(root.find(selector).first().text());
                if (value) return value;
            }
            return null;
        };
        const href = root.find('a[href*="Employee-Review-"]').first().attr('href') ?? null;
        const reviewId = reviewIdFromCard(card.attribs, href);
        if (!reviewId) return;
        const tags = root.find('[data-test="content-avatar-tag"]').toArray().map((element) => normalizeText($(element).text())).filter(Boolean);
        let employmentStatus: string | null = null;
        let employmentTenure: string | null = null;
        let location: string | null = null;
        for (const tag of tags) {
            const lower = tag.toLowerCase();
            if (/current employee|former employee/.test(lower)) {
                const parts = tag.split(',').map((part) => part.trim()).filter(Boolean);
                employmentStatus = parts[0] ?? null;
                employmentTenure = parts.slice(1).join(', ') || employmentTenure;
            } else if (/\b(year|month|less than|more than)\b/.test(lower)) {
                employmentTenure = tag;
            } else {
                location = tag;
            }
        }
        const rating = parseCompactNumber(text('[data-test="review-rating-label"]', '[data-test="rating-number"]'));
        const headline = text('a[href*="Employee-Review-"] h3', 'h3', '[data-test="review-title"]');
        const pros = text('[data-test="review-text-PROS"]', '[data-test="pros"]');
        const cons = text('[data-test="review-text-CONS"]', '[data-test="cons"]');
        const response = text('[data-test="employer-response"]', '[class*="EmployerResponse"]');
        reviews.push({
            companyName: name,
            companyUrl: summary.glassdoorUrl,
            employerId: summary.employerId,
            reviewId,
            reviewUrl: absoluteGlassdoorUrl(href, sourceUrl),
            headline,
            overallRating: rating,
            ratingBand: ratingBand(rating),
            ratingWorkLifeBalance: null,
            ratingCultureAndValues: null,
            ratingDiversityAndInclusion: null,
            ratingSeniorLeadership: null,
            ratingCareerOpportunities: null,
            ratingCompensationAndBenefits: null,
            recommendToFriend: null,
            ceoApproval: null,
            businessOutlook: null,
            jobTitle: text('[data-test="content-avatar-label"]', '[data-test="review-job-title"]'),
            employmentStatus,
            employmentType: null,
            isCurrentEmployee: employmentStatus ? /^current employee/i.test(employmentStatus) : null,
            employmentTenure,
            employmentTenureYears: null,
            location,
            reviewDate: root.find('time').first().attr('datetime') ?? text('[class*="Timestamp_reviewDate"]', 'time'),
            pros,
            cons,
            adviceToManagement: text('[data-test="review-text-ADVICE"]', '[data-test="advice"]'),
            employerResponse: response,
            employerResponseDate: text('[data-test="employer-response-date"]'),
            helpfulCount: parseCompactNumber(text('[data-test="helpful-count"]')),
            notHelpfulCount: null,
            featured: null,
            topics: detectTopics(headline, pros, cons),
            dataQualityWarnings: dataWarnings(text('[data-test="content-avatar-label"]', '[data-test="review-job-title"]')),
            scrapedAt,
        });
    });

    return {
        summary,
        reviews,
        currentPage: parsePageNumber(sourceUrl),
        numberOfPages: pageCountText.length ? Math.max(...pageCountText) : null,
        totalReviewsCount: summary.totalReviewsCount,
    };
}

function asObject(value: unknown): Record<string, any> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

export function parseBffReviewPage(payload: unknown, sourceUrl: string, scrapedAt = new Date().toISOString()): ParsedReviewPage {
    const root = Array.isArray(payload) ? asObject(payload[0]) : asObject(payload);
    const data = asObject(root?.data);
    const employerReviews = asObject(data?.employerReviews);
    if (!employerReviews || !Array.isArray(employerReviews.reviews)) throw new Error('Glassdoor reviews API response did not contain employer reviews.');
    const employer = asObject(employerReviews.employer) ?? {};
    const ratings = asObject(employerReviews.ratings) ?? {};
    const links = asObject(employer.links) ?? {};
    const companyUrl = absoluteGlassdoorUrl(links.reviewsUrl ?? null, sourceUrl) ?? reviewPageUrl(sourceUrl, 1);
    const summary: CompanySummary = {
        employerId: Number(employer.id ?? employerIdFromUrl(sourceUrl)) || employerIdFromUrl(sourceUrl),
        companyName: normalizeText(employer.shortName) || companyNameFromUrl(sourceUrl),
        glassdoorUrl: companyUrl,
        overallRating: parseCompactNumber(ratings.overallRating),
        recommendToFriendPct: ratings.recommendToFriendRating == null ? null : Math.round(Number(ratings.recommendToFriendRating) * (Number(ratings.recommendToFriendRating) <= 1 ? 100 : 1)),
        ceoApprovalPct: ratings.ceoRating == null ? null : Math.round(Number(ratings.ceoRating) * (Number(ratings.ceoRating) <= 1 ? 100 : 1)),
        businessOutlookPct: ratings.businessOutlookRating == null ? null : Math.round(Number(ratings.businessOutlookRating) * (Number(ratings.businessOutlookRating) <= 1 ? 100 : 1)),
        totalReviewsCount: parseCompactNumber(employerReviews.filteredReviewsCount ?? employerReviews.allReviewsCount ?? ratings.reviewCount),
        ratingCategories: Object.fromEntries([
            ['culture-and-values', ratings.cultureAndValuesRating],
            ['diversity-and-inclusion', ratings.diversityAndInclusionRating],
            ['career-opportunities', ratings.careerOpportunitiesRating],
            ['work-life-balance', ratings.workLifeBalanceRating],
            ['senior-management', ratings.seniorManagementRating],
            ['compensation-and-benefits', ratings.compensationAndBenefitsRating],
        ].filter(([, value]) => Number.isFinite(Number(value))).map(([key, value]) => [key, Number(value)])),
        scrapedAt,
    };
    const reviews: BaseReview[] = employerReviews.reviews.map((raw: unknown) => {
        const review = asObject(raw) ?? {};
        const jobTitle = asObject(review.jobTitle);
        const location = asObject(review.location);
        const reviewLinks = asObject(review.links);
        const responses = Array.isArray(review.employerResponses) ? review.employerResponses : [];
        const response = asObject(responses[0]);
        const rating = reviewRating(review.ratingOverall);
        const jobTitleText = nullableText(jobTitle?.text);
        const years = tenureYears(review.lengthOfEmployment);
        const headline = nullableText(review.summary ?? review.summaryOriginal);
        const pros = nullableText(review.pros ?? review.prosOriginal);
        const cons = nullableText(review.cons ?? review.consOriginal);
        const reviewUrl = absoluteGlassdoorUrl(reviewLinks?.reviewDetailUrl ?? null, sourceUrl)
            ?? (summary.employerId && review.reviewId
                ? `${new URL(sourceUrl).origin}/Reviews/Employee-Review-E${summary.employerId}-RVW${review.reviewId}.htm`
                : null);
        return {
            companyName: summary.companyName,
            companyUrl,
            employerId: summary.employerId,
            reviewId: normalizeText(review.reviewId),
            reviewUrl,
            headline,
            overallRating: rating,
            ratingBand: ratingBand(rating),
            ratingWorkLifeBalance: reviewRating(review.ratingWorkLifeBalance),
            ratingCultureAndValues: reviewRating(review.ratingCultureAndValues),
            ratingDiversityAndInclusion: reviewRating(review.ratingDiversityAndInclusion),
            ratingSeniorLeadership: reviewRating(review.ratingSeniorLeadership),
            ratingCareerOpportunities: reviewRating(review.ratingCareerOpportunities),
            ratingCompensationAndBenefits: reviewRating(review.ratingCompensationAndBenefits),
            recommendToFriend: nullableText(review.ratingRecommendToFriend),
            ceoApproval: nullableText(review.ratingCeo),
            businessOutlook: nullableText(review.ratingBusinessOutlook),
            jobTitle: jobTitleText,
            employmentStatus: review.isCurrentJob === true ? 'Current employee' : review.isCurrentJob === false ? 'Former employee' : null,
            employmentType: nullableText(review.employmentStatus),
            isCurrentEmployee: typeof review.isCurrentJob === 'boolean' ? review.isCurrentJob : null,
            employmentTenure: formattedTenure(review.lengthOfEmployment, years),
            employmentTenureYears: years,
            location: nullableText(location?.name),
            reviewDate: nullableText(review.reviewDateTime),
            pros,
            cons,
            adviceToManagement: nullableText(review.advice ?? review.adviceOriginal),
            employerResponse: nullableText(response?.response),
            employerResponseDate: nullableText(response?.responseDateTime),
            helpfulCount: parseCompactNumber(review.countHelpful),
            notHelpfulCount: parseCompactNumber(review.countNotHelpful),
            featured: typeof review.featured === 'boolean' ? review.featured : typeof review.isFeatured === 'boolean' ? review.isFeatured : null,
            topics: detectTopics(headline, pros, cons),
            dataQualityWarnings: dataWarnings(jobTitleText),
            scrapedAt,
        };
    }).filter((review: BaseReview) => Boolean(review.reviewId));

    return {
        summary,
        reviews,
        currentPage: Number(employerReviews.currentPage) || 1,
        numberOfPages: Number(employerReviews.numberOfPages) || null,
        totalReviewsCount: summary.totalReviewsCount,
    };
}

export function applyReviewFilters(reviews: BaseReview[], status: string, jobTitle: string, location: string): BaseReview[] {
    return reviews.filter((review) => {
        if (status && !(review.employmentStatus ?? '').toLowerCase().includes(status)) return false;
        if (jobTitle && !(review.jobTitle ?? '').toLowerCase().includes(jobTitle)) return false;
        if (location && !(review.location ?? '').toLowerCase().includes(location)) return false;
        return true;
    });
}
