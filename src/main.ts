import { Actor, log } from 'apify';
import type { ActorInput, AccessEvidence, CompanyReport, CompanySummary, CompanyWatchState, NormalizedInput, ParsedReviewPage } from './types.js';
import { normalizeCompanyUrl, normalizeInput } from './input.js';
import { buildAccessTiers, fetchBff, fetchHtml, resolveCompanyName, type AccessTier } from './access.js';
import {
    applyReviewFilters,
    employerIdFromUrl,
    hasUsableReviewPage,
    parseBffReviewPage,
    parseHtmlReviewPage,
    reviewPageUrl,
} from './parser.js';
import { applyMonitoring, watchStateKey, watchStoreName } from './monitoring.js';
import { buildCsv, buildMarkdown } from './reports.js';

interface CollectionResult {
    page: ParsedReviewPage;
    evidence: AccessEvidence;
}

function aggregatePages(pages: ParsedReviewPage[], input: NormalizedInput): ParsedReviewPage {
    if (!pages.length) throw new Error('No Glassdoor pages were parsed.');
    const reviews = [] as ParsedReviewPage['reviews'];
    const ids = new Set<string>();
    for (const page of pages) {
        for (const review of applyReviewFilters(
            page.reviews,
            input.filterByEmploymentStatus,
            input.filterByJobTitle,
            input.filterByLocation,
        )) {
            if (!ids.has(review.reviewId)) {
                ids.add(review.reviewId);
                reviews.push(review);
            }
            if (reviews.length >= input.maxReviewsPerCompany) break;
        }
        if (reviews.length >= input.maxReviewsPerCompany) break;
    }
    const first = pages[0];
    return {
        summary: pages.find((page) => page.summary.companyName)?.summary ?? first.summary,
        reviews: reviews.slice(0, input.maxReviewsPerCompany),
        currentPage: pages.at(-1)?.currentPage ?? first.currentPage,
        numberOfPages: pages.at(-1)?.numberOfPages ?? first.numberOfPages,
        totalReviewsCount: pages.at(-1)?.totalReviewsCount ?? first.totalReviewsCount,
    };
}

async function collectBff(
    tier: AccessTier,
    companyUrl: string,
    input: NormalizedInput,
    deadline: number,
    sessionId: string,
): Promise<CollectionResult> {
    const employerId = employerIdFromUrl(companyUrl);
    if (!employerId) throw new Error('Company URL does not contain a Glassdoor employer ID.');
    const pages: ParsedReviewPage[] = [];
    const rawIds = new Set<string>();
    const pageSize = Math.min(100, Math.max(10, input.maxReviewsPerCompany));
    const maxPages = Math.min(100, Math.max(2, Math.ceil(input.maxReviewsPerCompany / pageSize) + 5));
    let complete = false;
    let warning: string | undefined;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
        if (Date.now() >= deadline) {
            warning = 'Stopped at the configured run-time limit.';
            break;
        }
        const payload = await fetchBff(tier, companyUrl, employerId, pageNumber, pageSize, sessionId);
        const page = parseBffReviewPage(payload, companyUrl);
        pages.push(page);
        const before = rawIds.size;
        page.reviews.forEach((review) => rawIds.add(review.reviewId));
        const filteredCount = aggregatePages(pages, input).reviews.length;
        if (filteredCount >= input.maxReviewsPerCompany) {
            complete = true;
            break;
        }
        if (page.reviews.length === 0 || rawIds.size === before || (page.numberOfPages !== null && pageNumber >= page.numberOfPages)) {
            complete = true;
            break;
        }
    }
    if (!pages.length) throw new Error('Glassdoor reviews API returned no readable page.');
    if (!complete && !warning) warning = 'Stopped at the bounded reviews API page limit.';
    return {
        page: aggregatePages(pages, input),
        evidence: { tier: tier.label, source: 'bff', pagesFetched: pages.length, complete, ...(warning ? { warning } : {}) },
    };
}

async function collectHtml(
    tier: AccessTier,
    companyUrl: string,
    input: NormalizedInput,
    deadline: number,
    sessionId: string,
): Promise<CollectionResult> {
    const pages: ParsedReviewPage[] = [];
    const rawIds = new Set<string>();
    const maxPages = Math.min(100, Math.max(2, Math.ceil(input.maxReviewsPerCompany / 3) + 5));
    let complete = false;
    let warning: string | undefined;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
        if (Date.now() >= deadline) {
            warning = 'Stopped at the configured run-time limit.';
            break;
        }
        const url = reviewPageUrl(companyUrl, pageNumber);
        const response = await fetchHtml(tier, url, sessionId);
        if (!hasUsableReviewPage(response.body)) throw new Error('Glassdoor returned a page without review evidence.');
        const page = parseHtmlReviewPage(response.body, url);
        pages.push(page);
        const before = rawIds.size;
        page.reviews.forEach((review) => rawIds.add(review.reviewId));
        const filteredCount = aggregatePages(pages, input).reviews.length;
        if (filteredCount >= input.maxReviewsPerCompany) {
            complete = true;
            break;
        }
        if (page.reviews.length === 0 || rawIds.size === before || (page.numberOfPages !== null && pageNumber >= page.numberOfPages)) {
            complete = true;
            break;
        }
    }
    if (!pages.length) throw new Error('Glassdoor returned no readable HTML page.');
    if (!complete && !warning) warning = 'Stopped at the bounded HTML page limit.';
    return {
        page: aggregatePages(pages, input),
        evidence: { tier: tier.label, source: 'html', pagesFetched: pages.length, complete, ...(warning ? { warning } : {}) },
    };
}

async function collectCompany(
    companyUrl: string,
    tiers: AccessTier[],
    input: NormalizedInput,
    deadline: number,
): Promise<CollectionResult> {
    const companyKey = (employerIdFromUrl(companyUrl) ?? companyUrl.length).toString(36);
    const errors: string[] = [];
    for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
        const tier = tiers[tierIndex];
        const sessionId = `gd_${companyKey}_${tierIndex}`;
        const methods = tier.htmlFallback ? (['bff', 'html'] as const) : (['bff'] as const);
        for (const method of methods) {
            try {
                return method === 'html'
                    ? await collectHtml(tier, companyUrl, input, deadline, sessionId)
                    : await collectBff(tier, companyUrl, input, deadline, sessionId);
            } catch (error) {
                errors.push(`${tier.label} ${method === 'html' ? 'HTML' : 'reviews API'}: ${(error as Error).message}`);
            }
        }
    }
    throw new Error(errors.join(' | ').slice(0, 1_500) || 'No approved Glassdoor access tier succeeded.');
}

Actor.main(async () => {
    const input = normalizeInput(((await Actor.getInput<ActorInput>()) ?? {}) as ActorInput);
    const deadline = Date.now() + input.maxRunMinutes * 60_000 - 10_000;
    const tiers = await buildAccessTiers(input);
    const manager = Actor.getChargingManager();
    const watchStore = await Actor.openKeyValueStore(watchStoreName(input.watchlistName));
    const companyUrls = [...input.companyUrls];
    const unresolvedNames: string[] = [];

    await Actor.setStatusMessage(`Resolving ${input.companyNames.length} company name(s)`);
    for (const name of input.companyNames) {
        if (Date.now() >= deadline) break;
        const resolved = await resolveCompanyName(tiers, name);
        if (resolved) companyUrls.push(normalizeCompanyUrl(resolved));
        else unresolvedNames.push(name);
    }
    const uniqueUrls = [...new Set(companyUrls)];
    if (!uniqueUrls.length) {
        await Actor.setValue('OUTPUT', { status: 'FAILED', message: 'No company names could be resolved.', unresolvedNames });
        await Actor.fail('No Glassdoor company could be resolved. Use a direct company reviews URL.');
        return;
    }

    const reports: CompanyReport[] = [];
    const companySummaries: CompanySummary[] = [];
    const emittedRecords = [] as Awaited<ReturnType<typeof applyMonitoring>>['records'];
    const failures: Array<{ companyUrl: string; reason: string }> = [];
    let stoppedAtChargeLimit = false;
    let stateWriteFailures = 0;

    for (let index = 0; index < uniqueUrls.length; index++) {
        const companyUrl = uniqueUrls[index];
        if (Date.now() >= deadline) {
            failures.push({ companyUrl, reason: 'Not attempted because the run-time limit was reached.' });
            break;
        }
        await Actor.setStatusMessage(`Collecting company ${index + 1}/${uniqueUrls.length}`);
        try {
            const collection = await collectCompany(companyUrl, tiers, input, deadline);
            companySummaries.push(collection.page.summary);
            const key = watchStateKey(input.watchlistName, collection.page.summary.glassdoorUrl);
            const previous = (await watchStore.getValue<CompanyWatchState>(key)) ?? null;
            const monitoring = applyMonitoring(
                collection.page,
                previous,
                input,
                collection.evidence.complete ? 'complete' : 'partial',
            );
            let emittedForCompany = 0;
            for (const record of monitoring.records) {
                if (manager.calculateMaxEventChargeCountWithinLimit('review-scraped') < 1) {
                    stoppedAtChargeLimit = true;
                    break;
                }
                const chargeResult = await Actor.pushData(record, 'review-scraped');
                if (chargeResult.eventChargeLimitReached && chargeResult.chargedCount === 0) {
                    stoppedAtChargeLimit = true;
                    break;
                }
                emittedRecords.push(record);
                emittedForCompany++;
                if (chargeResult.eventChargeLimitReached) {
                    stoppedAtChargeLimit = true;
                    break;
                }
            }
            const fullySaved = emittedForCompany === monitoring.records.length;
            if (collection.evidence.complete && fullySaved && !stoppedAtChargeLimit) {
                try {
                    await watchStore.setValue(key, monitoring.nextState);
                } catch {
                    stateWriteFailures++;
                }
            }
            reports.push({
                companyName: collection.page.summary.companyName,
                companyUrl: collection.page.summary.glassdoorUrl,
                accessTier: collection.evidence.tier,
                source: collection.evidence.source,
                complete: collection.evidence.complete && fullySaved,
                collectedReviews: collection.page.reviews.length,
                emittedReviews: emittedForCompany,
                newReviews: monitoring.newReviewCount,
                seenReviews: monitoring.seenReviewCount,
                companyChangedFields: monitoring.companyChangedFields,
                ...(collection.evidence.warning ? { warning: collection.evidence.warning } : {}),
            });
            if (stoppedAtChargeLimit) break;
        } catch (error) {
            const reason = (error as Error).message.slice(0, 1_500);
            failures.push({ companyUrl, reason });
            log.warning(`Glassdoor company failed: ${reason}`);
        }
    }

    await Actor.setValue('COMPANIES', companySummaries);
    await Actor.setValue('MONITORING-REPORT', { watchlistName: input.watchlistName, companies: reports });
    await Actor.setValue('MONITORING-REPORT.md', buildMarkdown(
        reports,
        emittedRecords.length,
        reports.reduce((sum, report) => sum + report.newReviews, 0),
    ), { contentType: 'text/markdown; charset=utf-8' });
    await Actor.setValue('MONITORING-REPORT.csv', buildCsv(emittedRecords), { contentType: 'text/csv; charset=utf-8' });
    const output = {
        status: failures.length && reports.length === 0 ? 'FAILED' : failures.length ? 'PARTIAL' : stoppedAtChargeLimit ? 'BUDGET_LIMITED' : 'COMPLETE',
        partial: failures.length > 0 || reports.some((report) => !report.complete),
        watchlistName: input.watchlistName,
        onlyNewReviews: input.onlyNewReviews,
        requestedCompanies: uniqueUrls.length + unresolvedNames.length,
        completedCompanies: reports.filter((report) => report.complete).length,
        failedCompanies: failures.length + unresolvedNames.length,
        reviewsCollected: reports.reduce((sum, report) => sum + report.collectedReviews, 0),
        reviewsEmitted: emittedRecords.length,
        newReviewsObserved: reports.reduce((sum, report) => sum + report.newReviews, 0),
        companyChangesDetected: reports.filter((report) => report.companyChangedFields.length).length,
        stoppedAtChargeLimit,
        watchStoreId: watchStore.id,
        stateWriteFailures,
        unresolvedNames,
        failures,
        companiesKey: 'COMPANIES',
        monitoringReportKey: 'MONITORING-REPORT',
        markdownReportKey: 'MONITORING-REPORT.md',
        csvReportKey: 'MONITORING-REPORT.csv',
    };
    await Actor.setValue('OUTPUT', output);
    await Actor.setStatusMessage(`${output.status}: ${emittedRecords.length} review(s), ${reports.length} company(ies)`);
    if (reports.length === 0) await Actor.fail('Glassdoor blocked every approved access tier. No reviews were saved or charged.');
});
