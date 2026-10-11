import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCompanyUrl, normalizeInput } from '../dist/input.js';
import { applyMonitoring, changedCompanyFields, watchStateKey, watchStoreName } from '../dist/monitoring.js';
import {
    applyReviewFilters,
    detectTopics,
    hasUsableReviewPage,
    isBlockedGlassdoorPage,
    parseCompactNumber,
    parseBffReviewPage,
    parseHtmlReviewPage,
    ratingBand,
    reviewPageUrl,
} from '../dist/parser.js';
import { buildCsv, buildMarkdown } from '../dist/reports.js';
import { buildBffPayload } from '../dist/access.js';

const companyUrl = 'https://www.glassdoor.com/Reviews/Example-Co-Reviews-E123.htm';
const observedAt = '2026-10-11T00:00:00.000Z';

const html = `<!doctype html><html><body>
<h1>Example Co Reviews</h1>
<div data-test="rating-headline">4.2</div>
<div data-test="ei-review-count">1,234 Reviews</div>
<div data-test="recommendToFriend">82%</div>
<div data-test="ceoApprovalRating">77%</div>
<div>65% positive business outlook</div>
<div data-test="rating-category">4.1 Culture and Values</div>
<article data-test="review-detail" data-brandviews="review_id=9001">
  <div data-test="review-rating-label">5.0</div>
  <a href="/Reviews/Employee-Review-Example-Co-RVW9001.htm"><h3>Supportive remote team</h3></a>
  <div data-test="content-avatar-label">Software Engineer</div>
  <div data-test="content-avatar-tag">Current Employee, more than 3 years</div>
  <div data-test="content-avatar-tag">New York, NY</div>
  <time datetime="2026-10-10">Oct 10, 2026</time>
  <div data-test="review-text-PROS">Great culture, pay and remote work.</div>
  <div data-test="review-text-CONS">Some workload pressure.</div>
  <div data-test="review-text-ADVICE">Keep investing in managers.</div>
  <div data-test="employer-response">Thank you for the feedback.</div>
</article>
<article data-test="review-detail" data-brandviews="review_id=9002">
  <div data-test="review-rating-label">2.0</div>
  <a href="/Reviews/Employee-Review-Example-Co-RVW9002.htm"><h3>Needs improvement</h3></a>
  <div data-test="content-avatar-label">Sales Manager</div>
  <div data-test="content-avatar-tag">Former Employee</div>
  <div data-test="content-avatar-tag">Austin, TX</div>
  <time datetime="2026-10-09">Oct 9, 2026</time>
  <div data-test="review-text-PROS">Helpful colleagues.</div>
  <div data-test="review-text-CONS">Long hours and layoffs.</div>
</article>
<a href="/Reviews/Example-Co-Reviews-E123_P2.htm">2</a>
</body></html>`;

const graphPayload = { data: { employerReviews: {
    employer: { id: 123, shortName: 'Example Co', links: { reviewsUrl: companyUrl } },
    currentPage: 1,
    numberOfPages: 2,
    allReviewsCount: 12,
    ratings: {
        overallRating: 4.2,
        reviewCount: 12,
        ceoRating: 0.77,
        recommendToFriendRating: 0.82,
        businessOutlookRating: 0.65,
        cultureAndValuesRating: 4.1,
        careerOpportunitiesRating: 3.8,
    },
    reviews: [{
        reviewId: 9001,
        reviewDateTime: '2026-10-10',
        ratingOverall: 5,
        ratingWorkLifeBalance: 4,
        ratingCultureAndValues: 5,
        ratingDiversityAndInclusion: 4,
        ratingSeniorLeadership: 3,
        ratingCareerOpportunities: 4,
        ratingCompensationAndBenefits: 5,
        ratingRecommendToFriend: 'POSITIVE',
        ratingCeo: 'APPROVE',
        ratingBusinessOutlook: 'POSITIVE',
        isCurrentJob: true,
        lengthOfEmployment: 'MORE_THAN_3_YEARS',
        jobTitle: { text: 'Software Engineer' },
        location: { name: 'New York, NY' },
        pros: 'Great pay and culture',
        cons: 'Occasional overtime',
        summary: 'Supportive team',
        advice: 'Keep listening',
        countHelpful: 17,
        countNotHelpful: 2,
        featured: true,
        employerResponses: [{ response: 'Thank you', responseDateTime: '2026-10-11' }],
        links: { reviewDetailUrl: '/Reviews/Employee-Review-Example-Co-RVW9001.htm' },
    }],
} } };

function makeInput(overrides = {}) {
    return normalizeInput({ companyUrls: [companyUrl], ...overrides });
}

test('input defaults are bounded for the automated quality run', () => {
    const input = makeInput();
    assert.equal(input.maxReviewsPerCompany, 3);
    assert.equal(input.maxRunMinutes, 5);
    assert.equal(input.useUnblocker, true);
});

test('legacy Residential fallback input maps to the specialist fallback during migration', () => {
    assert.equal(makeInput({ allowResidentialFallback: false }).useUnblocker, false);
    assert.equal(makeInput({ allowResidentialFallback: true }).useUnblocker, true);
    assert.equal(makeInput({ allowUnblockerFallback: false }).useUnblocker, false);
});

test('input strips pagination and query data from Glassdoor URLs', () => {
    assert.equal(
        normalizeCompanyUrl('https://www.glassdoor.com/Reviews/Example-Co-Reviews-E123_P4.htm?filter=1#reviews'),
        companyUrl,
    );
});

test('input rejects non-Glassdoor and non-review URLs', () => {
    assert.throws(() => normalizeCompanyUrl('https://example.com/Reviews/Fake-Reviews-E1.htm'));
    assert.throws(() => normalizeCompanyUrl('https://www.glassdoor.com/Overview/Working-at-Example.htm'));
});

test('input enforces company and result limits', () => {
    assert.throws(() => normalizeInput({ companyUrls: Array.from({ length: 21 }, (_, i) => `https://www.glassdoor.com/Reviews/A${i}-Reviews-E${i + 1}.htm`) }));
    assert.throws(() => makeInput({ maxReviewsPerCompany: 501 }));
});

test('compact number and rating helpers normalize output', () => {
    assert.equal(parseCompactNumber('1.2K Reviews'), 1200);
    assert.equal(ratingBand(4), 'positive');
    assert.equal(ratingBand(3.5), 'mixed');
    assert.equal(ratingBand(2.9), 'negative');
});

test('page URL generation is stable', () => {
    assert.equal(reviewPageUrl(companyUrl, 2), 'https://www.glassdoor.com/Reviews/Example-Co-Reviews-E123_P2.htm');
    assert.equal(reviewPageUrl(reviewPageUrl(companyUrl, 3), 1), companyUrl);
});

test('BFF request uses the current endpoint payload shape', () => {
    assert.deepEqual(buildBffPayload(9079, 2, 25), {
        applyDefaultCriteria: true,
        employerId: 9079,
        employmentStatuses: ['REGULAR', 'PART_TIME'],
        jobTitle: null,
        goc: null,
        location: {},
        defaultLanguage: 'eng',
        language: 'eng',
        onlyCurrentEmployees: false,
        overallRating: null,
        pageSize: 25,
        page: 2,
        sort: 'DATE',
        textSearch: '',
        worldwideFilter: false,
        dynamicProfileId: 9079,
        enableKeywordSearch: false,
    });
});

test('Cloudflare pages are rejected and review pages are accepted', () => {
    assert.equal(isBlockedGlassdoorPage(403, '<html></html>'), true);
    assert.equal(isBlockedGlassdoorPage(200, '<title>Just a moment...</title>'), true);
    assert.equal(hasUsableReviewPage(html), true);
});

test('HTML parser extracts company, reviews, ratings and topics', () => {
    const page = parseHtmlReviewPage(html, companyUrl, observedAt);
    assert.equal(page.summary.companyName, 'Example Co');
    assert.equal(page.summary.totalReviewsCount, 1234);
    assert.equal(page.summary.overallRating, 4.2);
    assert.equal(page.numberOfPages, 2);
    assert.equal(page.reviews.length, 2);
    assert.equal(page.reviews[0].reviewId, '9001');
    assert.deepEqual(page.reviews[0].topics, ['compensation', 'culture', 'remote-work', 'workload']);
    assert.equal(page.reviews[1].ratingBand, 'negative');
});

test('BFF parser extracts review detail and employer response', () => {
    const page = parseBffReviewPage(graphPayload, companyUrl, observedAt);
    assert.equal(page.summary.recommendToFriendPct, 82);
    assert.equal(page.summary.ceoApprovalPct, 77);
    assert.equal(page.reviews[0].employerResponse, 'Thank you');
    assert.equal(page.reviews[0].ratingCompensationAndBenefits, 5);
    assert.equal(page.reviews[0].ratingDiversityAndInclusion, 4);
    assert.equal(page.reviews[0].recommendToFriend, 'POSITIVE');
    assert.equal(page.reviews[0].helpfulCount, 17);
    assert.equal(page.reviews[0].isCurrentEmployee, true);
    assert.equal(page.reviews[0].employmentStatus, 'Current employee');
    assert.equal(page.reviews[0].employmentType, null);
    assert.equal(page.reviews[0].employmentTenure, 'More than 3 years');
    assert.equal(page.reviews[0].employmentTenureYears, null);
    assert.equal(page.reviews[0].reviewUrl, 'https://www.glassdoor.com/Reviews/Employee-Review-Example-Co-RVW9001.htm');
});

test('BFF parser separates employee status from employment type and treats zero subratings as missing', () => {
    const payload = structuredClone(graphPayload);
    payload.data.employerReviews.reviews[0].ratingWorkLifeBalance = 0;
    const review = parseBffReviewPage(payload, companyUrl, observedAt).reviews[0];
    assert.equal(review.employmentStatus, 'Current employee');
    assert.equal(review.employmentType, null);
    assert.equal(review.employmentTenure, 'More than 3 years');
    assert.equal(review.employmentTenureYears, null);
    assert.equal(review.ratingWorkLifeBalance, null);
});

test('review filters combine employment status, title and location', () => {
    const page = parseHtmlReviewPage(html, companyUrl, observedAt);
    assert.equal(applyReviewFilters(page.reviews, 'current', 'engineer', 'new york').length, 1);
    assert.equal(applyReviewFilters(page.reviews, 'former', 'engineer', '').length, 0);
});

test('topic detection is deterministic and transparent', () => {
    assert.deepEqual(detectTopics('Remote work', 'good salary', 'poor management'), ['compensation', 'management', 'remote-work']);
});

test('first watchlist run creates a baseline with per-review history', () => {
    const page = parseHtmlReviewPage(html, companyUrl, observedAt);
    const decision = applyMonitoring(page, null, makeInput(), 'complete', observedAt);
    assert.equal(decision.records.every((record) => record.monitoringStatus === 'baseline'), true);
    assert.equal(decision.nextState.reviewObservationCounts['9001'], 1);
    assert.equal(decision.nextState.reviewFirstObservedAt['9001'], observedAt);
});

test('repeat watchlist run marks seen reviews and increments per-review count', () => {
    const page = parseHtmlReviewPage(html, companyUrl, observedAt);
    const first = applyMonitoring(page, null, makeInput(), 'complete', observedAt);
    const later = '2026-10-12T00:00:00.000Z';
    const second = applyMonitoring(page, first.nextState, makeInput(), 'complete', later);
    assert.equal(second.records[0].monitoringStatus, 'seen');
    assert.equal(second.records[0].firstObservedAt, observedAt);
    assert.equal(second.records[0].observationCount, 2);
});

test('only-new mode suppresses repeat rows without losing state', () => {
    const page = parseHtmlReviewPage(html, companyUrl, observedAt);
    const first = applyMonitoring(page, null, makeInput(), 'complete', observedAt);
    const second = applyMonitoring(page, first.nextState, makeInput({ onlyNewReviews: true }), 'complete', '2026-10-12T00:00:00.000Z');
    assert.equal(second.records.length, 0);
    assert.equal(second.nextState.seenReviewIds.length, 2);
});

test('company metric changes are explicit', () => {
    const first = parseHtmlReviewPage(html, companyUrl, observedAt).summary;
    const next = { ...first, overallRating: 4.3, totalReviewsCount: 1235 };
    assert.deepEqual(changedCompanyFields(first, next), ['overallRating', 'totalReviewsCount']);
});

test('watchlist storage keys do not reveal names or URLs', () => {
    const key = watchStateKey('US competitors', companyUrl);
    assert.match(key, /^WATCHLIST-[a-f0-9]{32}$/);
    assert.equal(key.includes('Glassdoor'), false);
});

test('watchlist history uses a stable private named store across runs', () => {
    const first = watchStoreName('US competitors');
    assert.equal(first, watchStoreName(' us COMPETITORS '));
    assert.match(first, /^glassdoor-watchlist-v1-[a-f0-9]{24}$/);
    assert.equal(first.includes('competitors'), false);
});

test('CSV protects spreadsheet formulas', () => {
    const page = parseHtmlReviewPage(html, companyUrl, observedAt);
    const decision = applyMonitoring(page, null, makeInput(), 'complete', observedAt);
    decision.records[0].headline = '=HYPERLINK("bad")';
    assert.match(buildCsv(decision.records), /"'=HYPERLINK\(""bad""\)"/);
    assert.match(buildCsv(decision.records), /"pros"/);
    assert.match(buildCsv(decision.records), /"watchlistName"/);
});

test('Markdown report includes processing evidence', () => {
    const report = buildMarkdown([{
        companyName: 'Example Co', companyUrl, accessTier: 'direct', source: 'bff', complete: true,
        collectedReviews: 2, emittedReviews: 2, newReviews: 0, seenReviews: 0, companyChangedFields: [],
    }], 2, 0);
    assert.match(report, /Example Co/);
    assert.match(report, /\| bff \| direct \| 2 \| 2 \|/);
});
