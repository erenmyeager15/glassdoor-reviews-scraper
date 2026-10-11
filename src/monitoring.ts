import { createHash } from 'node:crypto';
import type { CompanySummary, CompanyWatchState, MonitoringDecision, NormalizedInput, ParsedReviewPage } from './types.js';

const SUMMARY_FIELDS: Array<keyof CompanySummary> = [
    'overallRating', 'recommendToFriendPct', 'ceoApprovalPct', 'businessOutlookPct', 'totalReviewsCount',
];

export function watchStateKey(watchlistName: string, companyUrl: string): string {
    const hash = createHash('sha256').update(`${watchlistName}\n${companyUrl}`).digest('hex').slice(0, 32);
    return `WATCHLIST-${hash}`;
}

export function watchStoreName(watchlistName: string): string {
    const hash = createHash('sha256').update(watchlistName.trim().toLowerCase()).digest('hex').slice(0, 24);
    return `glassdoor-watchlist-v1-${hash}`;
}

export function changedCompanyFields(previous: CompanySummary | undefined, current: CompanySummary): string[] {
    if (!previous) return [];
    const changed = SUMMARY_FIELDS.filter((field) => {
        const before = previous[field];
        const after = current[field];
        return before !== null && after !== null && before !== after;
    }).map(String);
    const ratingKeys = new Set([...Object.keys(previous.ratingCategories), ...Object.keys(current.ratingCategories)]);
    for (const key of ratingKeys) {
        const before = previous.ratingCategories[key];
        const after = current.ratingCategories[key];
        if (before !== undefined && after !== undefined && before !== after) changed.push(`ratingCategories.${key}`);
    }
    return changed;
}

export function applyMonitoring(
    page: ParsedReviewPage,
    previous: CompanyWatchState | null,
    input: NormalizedInput,
    sourceQuality: 'complete' | 'partial',
    observedAt = new Date().toISOString(),
): MonitoringDecision {
    const seen = new Set(previous?.seenReviewIds ?? []);
    const previousFirstSeen = previous?.reviewFirstObservedAt ?? {};
    const previousObservationCounts = previous?.reviewObservationCounts ?? {};
    const companyChangedFields = changedCompanyFields(previous?.summary, page.summary);
    const observationCount = (previous?.observationCount ?? 0) + 1;
    let newReviewCount = 0;
    let seenReviewCount = 0;
    const allRecords = page.reviews.map((review) => {
        const isSeen = seen.has(review.reviewId);
        const monitoringStatus = previous ? (isSeen ? 'seen' : 'new') : 'baseline';
        if (monitoringStatus === 'new') newReviewCount++;
        if (monitoringStatus === 'seen') seenReviewCount++;
        return {
            ...review,
            monitoringStatus,
            firstObservedAt: previousFirstSeen[review.reviewId] ?? observedAt,
            observationCount: (previousObservationCounts[review.reviewId] ?? 0) + 1,
            watchlistName: input.watchlistName,
            companyChangeDetected: companyChangedFields.length > 0,
            companyChangedFields,
            sourceQuality,
        } as const;
    });
    const records = input.onlyNewReviews && previous
        ? allRecords.filter((record) => record.monitoringStatus === 'new')
        : allRecords;
    const combinedIds = [...new Set([...page.reviews.map((review) => review.reviewId), ...(previous?.seenReviewIds ?? [])])].slice(0, 5_000);
    const reviewFirstObservedAt = Object.fromEntries(combinedIds.map((id) => [
        id,
        previousFirstSeen[id] ?? observedAt,
    ]));
    const observedThisRun = new Set(page.reviews.map((review) => review.reviewId));
    const reviewObservationCounts = Object.fromEntries(combinedIds.map((id) => [
        id,
        (previousObservationCounts[id] ?? 0) + (observedThisRun.has(id) ? 1 : 0),
    ]));
    const nextState: CompanyWatchState = {
        version: 1,
        companyUrl: page.summary.glassdoorUrl,
        companyName: page.summary.companyName,
        firstObservedAt: previous?.firstObservedAt ?? observedAt,
        lastObservedAt: observedAt,
        observationCount,
        seenReviewIds: combinedIds,
        reviewFirstObservedAt,
        reviewObservationCounts,
        summary: page.summary,
    };
    return { records, nextState, companyChangedFields, newReviewCount, seenReviewCount };
}
