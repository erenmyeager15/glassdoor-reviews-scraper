import type { ActorInput, AccessEvidence, CompanyReport, CompanySummary, CompanyWatchState, NormalizedInput, ParsedReviewPage } from './types.js';
import { normalizeCompanyUrl, normalizeInput } from './input.js';
import type { AccessTier, fetchBff, fetchHtml, resolveCompanyName } from './access.js';
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

export function safeFailureReason(error: unknown): string {
    return (error instanceof Error ? error.message : String(error))
        .replace(/https?:\/\/[^\s"<>]+/gi, '[URL]')
        .replace(/(token|password|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
        .slice(0, 1_500);
}

function remainingReviews(runtime: CollectorRuntime): number {
    const count = runtime.remainingReviews();
    if (count !== Infinity && (!Number.isFinite(count) || count < 0)) {
        throw new Error('Invalid remaining review budget; stopped before requesting unbillable output.');
    }
    return Math.floor(count);
}

export interface CollectorRuntime {
    now(): number;
    buildAccessTiers(input: NormalizedInput): Promise<AccessTier[]>;
    fetchBff: typeof fetchBff;
    fetchHtml: typeof fetchHtml;
    resolveCompanyName: typeof resolveCompanyName;
    remainingReviews(): number;
    pushReview(record: ReturnType<typeof applyMonitoring>['records'][number]): Promise<{ chargedCount?: number; eventChargeLimitReached?: boolean }>;
    openWatchStore(name: string): Promise<{
        id: string;
        getValue(key: string): Promise<CompanyWatchState | null>;
        setValue(key: string, value: CompanyWatchState): Promise<void>;
    }>;
    setValue(key: string, value: unknown, options?: { contentType: string }): Promise<void>;
    setStatus(message: string): Promise<void>;
    warn(message: string): void;
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
    runtime: CollectorRuntime,
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
        if (runtime.now() >= deadline) {
            warning = 'Stopped at the configured run-time limit.';
            break;
        }
        let page: ParsedReviewPage;
        try {
            const payload = await runtime.fetchBff(tier, companyUrl, employerId, pageNumber, pageSize, sessionId, deadline);
            page = parseBffReviewPage(payload, companyUrl);
        } catch (error) {
            if (!pages.length) throw error;
            warning = `Later reviews page failed; earlier readable reviews retained: ${safeFailureReason(error)}`;
            break;
        }
        pages.push(page);
        const before = rawIds.size;
        page.reviews.forEach((review) => rawIds.add(review.reviewId));
        const filteredCount = aggregatePages(pages, input).reviews.length;
        if (filteredCount >= input.maxReviewsPerCompany) {
            complete = true;
            break;
        }
        if (page.reviews.length > 0 && rawIds.size === before) {
            warning = 'Glassdoor repeated an earlier reviews page before the requested limit; collection is partial.';
            break;
        }
        if (page.reviews.length === 0 || (page.numberOfPages !== null && pageNumber >= page.numberOfPages)) {
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
    runtime: CollectorRuntime,
): Promise<CollectionResult> {
    const pages: ParsedReviewPage[] = [];
    const rawIds = new Set<string>();
    const maxPages = Math.min(100, Math.max(2, Math.ceil(input.maxReviewsPerCompany / 3) + 5));
    let complete = false;
    let warning: string | undefined;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
        if (runtime.now() >= deadline) {
            warning = 'Stopped at the configured run-time limit.';
            break;
        }
        const url = reviewPageUrl(companyUrl, pageNumber);
        let page: ParsedReviewPage;
        try {
            const response = await runtime.fetchHtml(tier, url, sessionId, deadline);
            if (!hasUsableReviewPage(response.body)) throw new Error('Glassdoor returned a page without review evidence.');
            page = parseHtmlReviewPage(response.body, url);
        } catch (error) {
            if (!pages.length) throw error;
            warning = `Later HTML page failed; earlier readable reviews retained: ${safeFailureReason(error)}`;
            break;
        }
        pages.push(page);
        const before = rawIds.size;
        page.reviews.forEach((review) => rawIds.add(review.reviewId));
        const filteredCount = aggregatePages(pages, input).reviews.length;
        if (filteredCount >= input.maxReviewsPerCompany) {
            complete = true;
            break;
        }
        if (page.reviews.length > 0 && rawIds.size === before) {
            warning = 'Glassdoor repeated an earlier HTML page before the requested limit; collection is partial.';
            break;
        }
        if (page.reviews.length === 0 || (page.numberOfPages !== null && pageNumber >= page.numberOfPages)) {
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
    runtime: CollectorRuntime,
): Promise<CollectionResult> {
    const companyKey = (employerIdFromUrl(companyUrl) ?? companyUrl.length).toString(36);
    const errors: string[] = [];
    for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
        const tier = tiers[tierIndex];
        const sessionId = `gd_${companyKey}_${tierIndex}`;
        const methods = tier.htmlFallback ? (['bff', 'html'] as const) : (['bff'] as const);
        for (const method of methods) {
            if (runtime.now() >= deadline) throw new Error('Stopped before another access attempt at the configured run-time limit.');
            try {
                return method === 'html'
                    ? await collectHtml(tier, companyUrl, input, deadline, sessionId, runtime)
                    : await collectBff(tier, companyUrl, input, deadline, sessionId, runtime);
            } catch (error) {
                errors.push(`${tier.label} ${method === 'html' ? 'HTML' : 'reviews API'}: ${safeFailureReason(error)}`);
            }
        }
    }
    throw new Error(errors.join(' | ').slice(0, 1_500) || 'No approved Glassdoor access tier succeeded.');
}

export async function runGlassdoor(rawInput: ActorInput, runtime: CollectorRuntime) {
    const input = normalizeInput(rawInput);
    const deadline = runtime.now() + input.maxRunMinutes * 60_000 - 10_000;
    if (remainingReviews(runtime) === 0) {
        const output = { status: 'BUDGET_LIMITED', partial: true, watchlistName: input.watchlistName,
            onlyNewReviews: input.onlyNewReviews, requestedCompanies: input.companyUrls.length + input.companyNames.length,
            completedCompanies: 0, failedCompanies: 0, unattemptedCompanies: input.companyUrls.length + input.companyNames.length,
            reviewsCollected: 0, reviewsEmitted: 0, newReviewsObserved: 0, companyChangesDetected: 0,
            stoppedAtChargeLimit: true, watchStoreId: null, stateWriteFailures: 0, unresolvedNames: [], failures: [],
            companiesKey: 'COMPANIES', monitoringReportKey: 'MONITORING-REPORT', markdownReportKey: 'MONITORING-REPORT.md',
            csvReportKey: 'MONITORING-REPORT.csv' };
        await runtime.setValue('COMPANIES', []);
        await runtime.setValue('MONITORING-REPORT', { watchlistName: input.watchlistName, companies: [] });
        await runtime.setValue('MONITORING-REPORT.md', buildMarkdown([], 0, 0), { contentType: 'text/markdown; charset=utf-8' });
        await runtime.setValue('MONITORING-REPORT.csv', buildCsv([]), { contentType: 'text/csv; charset=utf-8' });
        await runtime.setValue('OUTPUT', output);
        await runtime.setStatus('BUDGET_LIMITED: stopped before proxy setup or source traffic; no review charges remain.');
        return output;
    }
    const tiers = await runtime.buildAccessTiers(input);
    const watchStore = await runtime.openWatchStore(watchStoreName(input.watchlistName));
    const companyUrls = [...input.companyUrls];
    const unresolvedNames: string[] = [];

    await runtime.setStatus(`Resolving ${input.companyNames.length} company name(s)`);
    for (const name of input.companyNames) {
        if (runtime.now() >= deadline) { unresolvedNames.push(name); continue; }
        const resolved = await runtime.resolveCompanyName(tiers, name, deadline);
        if (resolved) companyUrls.push(normalizeCompanyUrl(resolved));
        else unresolvedNames.push(name);
    }
    const uniqueUrls = [...new Set(companyUrls)];
    if (!uniqueUrls.length) {
        const output = { status: 'FAILED', message: 'No company names could be resolved.', unresolvedNames };
        await runtime.setValue('OUTPUT', output);
        return output;
    }

    const reports: CompanyReport[] = [];
    const companySummaries: CompanySummary[] = [];
    const emittedRecords = [] as Awaited<ReturnType<typeof applyMonitoring>>['records'];
    const failures: Array<{ companyUrl: string; reason: string }> = [];
    const pendingStates: Array<{ key: string; state: CompanyWatchState; report: CompanyReport }> = [];
    let stoppedAtChargeLimit = false;
    let stateWriteFailures = 0;
    let outputBillingFailure: string | null = null;
    let attemptedCompanies = 0;
    let stoppedAtTimeLimit = false;

    for (let index = 0; index < uniqueUrls.length; index++) {
        const companyUrl = uniqueUrls[index];
        const affordable = remainingReviews(runtime);
        if (affordable === 0) { stoppedAtChargeLimit = true; break; }
        if (runtime.now() >= deadline) {
            stoppedAtTimeLimit = true;
            break;
        }
        await runtime.setStatus(`Collecting company ${index + 1}/${uniqueUrls.length}`);
        attemptedCompanies++;
        try {
            const collectionInput = { ...input, maxReviewsPerCompany: Math.min(input.maxReviewsPerCompany, affordable) };
            const collection = await collectCompany(companyUrl, tiers, collectionInput, deadline, runtime);
            if (collectionInput.maxReviewsPerCompany < input.maxReviewsPerCompany
                && collection.page.reviews.length >= collectionInput.maxReviewsPerCompany) {
                collection.evidence.complete = false;
                collection.evidence.warning = 'Review budget capped this company sample below the requested limit.';
            }
            companySummaries.push(collection.page.summary);
            const key = watchStateKey(input.watchlistName, collection.page.summary.glassdoorUrl);
            const previous = (await watchStore.getValue(key)) ?? null;
            const monitoring = applyMonitoring(
                collection.page,
                previous,
                input,
                collection.evidence.complete ? 'complete' : 'partial',
            );
            let emittedForCompany = 0;
            for (const record of monitoring.records) {
                if (remainingReviews(runtime) < 1) {
                    stoppedAtChargeLimit = true;
                    break;
                }
                let chargeResult: Awaited<ReturnType<CollectorRuntime['pushReview']>>;
                try {
                    chargeResult = await runtime.pushReview(record);
                } catch (error) {
                    outputBillingFailure = safeFailureReason(error);
                    break;
                }
                if (chargeResult.eventChargeLimitReached && chargeResult.chargedCount === 0) {
                    stoppedAtChargeLimit = true;
                    break;
                }
                emittedRecords.push(record);
                emittedForCompany++;
                if (chargeResult.eventChargeLimitReached || remainingReviews(runtime) === 0) {
                    stoppedAtChargeLimit = true;
                    break;
                }
            }
            const fullySaved = emittedForCompany === monitoring.records.length;
            const report: CompanyReport = {
                companyName: collection.page.summary.companyName,
                companyUrl: collection.page.summary.glassdoorUrl,
                accessTier: collection.evidence.tier,
                source: collection.evidence.source,
                complete: collection.evidence.complete && fullySaved,
                historyCommitted: false,
                collectedReviews: collection.page.reviews.length,
                emittedReviews: emittedForCompany,
                newReviews: monitoring.newReviewCount,
                seenReviews: monitoring.seenReviewCount,
                companyChangedFields: monitoring.companyChangedFields,
                ...(collection.evidence.warning ? { warning: collection.evidence.warning } : {}),
            };
            reports.push(report);
            if (report.complete && !outputBillingFailure) pendingStates.push({ key, state: monitoring.nextState, report });
            if (stoppedAtChargeLimit || outputBillingFailure) break;
        } catch (error) {
            const reason = safeFailureReason(error);
            failures.push({ companyUrl, reason });
            runtime.warn(`Glassdoor company failed: ${reason}`);
        }
    }

    const saveMonitoringReports = async () => {
        await runtime.setValue('MONITORING-REPORT', { watchlistName: input.watchlistName, companies: reports });
        await runtime.setValue('MONITORING-REPORT.md', buildMarkdown(
        reports,
        emittedRecords.length,
        reports.reduce((sum, report) => sum + report.newReviews, 0),
        ), { contentType: 'text/markdown; charset=utf-8' });
    };
    let reportExportFailure: string | null = null;
    try {
        await runtime.setValue('COMPANIES', companySummaries);
        await saveMonitoringReports();
        await runtime.setValue('MONITORING-REPORT.csv', buildCsv(emittedRecords), { contentType: 'text/csv; charset=utf-8' });
    } catch (error) {
        reportExportFailure = safeFailureReason(error);
    }
    // Exports must succeed before only-new history advances. A failed output push
    // also prevents this run's baseline from hiding previously undelivered rows.
    if (!reportExportFailure && !outputBillingFailure) {
        for (const pending of pendingStates) {
            try {
                await watchStore.setValue(pending.key, pending.state);
                pending.report.historyCommitted = true;
            } catch {
                stateWriteFailures++;
                pending.report.complete = false;
                pending.report.warning = 'Reviews saved, but watchlist state write failed; history commit is unconfirmed.';
            }
        }
        try {
            await saveMonitoringReports();
        } catch (error) {
            // A post-commit report error is not claimed to roll history back.
            reportExportFailure = safeFailureReason(error);
        }
    }
    const output = {
        status: outputBillingFailure || reportExportFailure ? 'FAILED' : stoppedAtChargeLimit ? 'BUDGET_LIMITED'
            : reports.length === 0 ? 'FAILED'
                : failures.length || unresolvedNames.length || stoppedAtTimeLimit || reports.some(report => !report.complete) ? 'PARTIAL' : 'COMPLETE',
        partial: failures.length > 0 || unresolvedNames.length > 0 || reports.some((report) => !report.complete)
            || stateWriteFailures > 0 || stoppedAtChargeLimit || stoppedAtTimeLimit || Boolean(outputBillingFailure || reportExportFailure),
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
        stoppedAtTimeLimit,
        watchStoreId: watchStore.id,
        stateWriteFailures,
        unattemptedCompanies: uniqueUrls.length - attemptedCompanies,
        ...(outputBillingFailure ? { failureStage: 'OUTPUT_BILLING', outputBillingFailure } : {}),
        ...(!outputBillingFailure && reportExportFailure ? { failureStage: 'REPORT_EXPORT', reportExportFailure } : {}),
        historyCommittedCompanies: reports.filter(report => report.historyCommitted).map(report => report.companyUrl),
        unresolvedNames,
        failures,
        companiesKey: 'COMPANIES',
        monitoringReportKey: 'MONITORING-REPORT',
        markdownReportKey: 'MONITORING-REPORT.md',
        csvReportKey: 'MONITORING-REPORT.csv',
    };
    await runtime.setValue('OUTPUT', output);
    await runtime.setStatus(`${output.status}: ${emittedRecords.length} review(s), ${reports.length} company(ies)`);
    return output;
}
