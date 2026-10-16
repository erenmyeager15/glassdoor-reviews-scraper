export interface ProxyConfigInput {
    useApifyProxy?: boolean;
    apifyProxyGroups?: string[];
    apifyProxyCountry?: string;
    proxyUrls?: string[];
}

export interface ActorInput {
    companyUrls?: string[];
    companyNames?: string[];
    maxReviewsPerCompany?: number;
    filterByEmploymentStatus?: '' | 'current' | 'former';
    filterByJobTitle?: string;
    filterByLocation?: string;
    watchlistName?: string;
    onlyNewReviews?: boolean;
    useUnblocker?: boolean;
    /** Deprecated compatibility alias for the first v1.2 staging input. */
    allowUnblockerFallback?: boolean;
    /** Deprecated compatibility alias for staging inputs created before v1.2. */
    allowResidentialFallback?: boolean;
    maxRunMinutes?: number;
    proxyConfiguration?: ProxyConfigInput;
}

export interface NormalizedInput {
    companyUrls: string[];
    companyNames: string[];
    maxReviewsPerCompany: number;
    filterByEmploymentStatus: '' | 'current' | 'former';
    filterByJobTitle: string;
    filterByLocation: string;
    watchlistName: string;
    onlyNewReviews: boolean;
    useUnblocker: boolean;
    maxRunMinutes: number;
    proxyConfiguration?: ProxyConfigInput;
}

export interface CompanySummary {
    employerId: number | null;
    companyName: string;
    glassdoorUrl: string;
    overallRating: number | null;
    recommendToFriendPct: number | null;
    ceoApprovalPct: number | null;
    businessOutlookPct: number | null;
    totalReviewsCount: number | null;
    ratingCategories: Record<string, number>;
    scrapedAt: string;
}

export type MonitoringStatus = 'baseline' | 'new' | 'seen';
export type RatingBand = 'positive' | 'mixed' | 'negative' | 'unknown';

export interface ReviewRecord {
    companyName: string;
    companyUrl: string;
    employerId: number | null;
    reviewId: string;
    reviewUrl: string | null;
    headline: string | null;
    overallRating: number | null;
    ratingBand: RatingBand;
    ratingWorkLifeBalance: number | null;
    ratingCultureAndValues: number | null;
    ratingDiversityAndInclusion: number | null;
    ratingSeniorLeadership: number | null;
    ratingCareerOpportunities: number | null;
    ratingCompensationAndBenefits: number | null;
    recommendToFriend: string | null;
    ceoApproval: string | null;
    businessOutlook: string | null;
    jobTitle: string | null;
    employmentStatus: string | null;
    employmentType: string | null;
    isCurrentEmployee: boolean | null;
    employmentTenure: string | null;
    employmentTenureYears: number | null;
    location: string | null;
    reviewDate: string | null;
    pros: string | null;
    cons: string | null;
    adviceToManagement: string | null;
    employerResponse: string | null;
    employerResponseDate: string | null;
    helpfulCount: number | null;
    notHelpfulCount: number | null;
    featured: boolean | null;
    topics: string[];
    dataQualityWarnings: string[];
    monitoringStatus: MonitoringStatus;
    firstObservedAt: string;
    observationCount: number;
    watchlistName: string;
    companyChangeDetected: boolean;
    companyChangedFields: string[];
    sourceQuality: 'complete' | 'partial';
    scrapedAt: string;
}

export interface ParsedReviewPage {
    summary: CompanySummary;
    reviews: Omit<ReviewRecord,
        'monitoringStatus' | 'firstObservedAt' | 'observationCount' | 'watchlistName'
        | 'companyChangeDetected' | 'companyChangedFields' | 'sourceQuality'>[];
    currentPage: number;
    numberOfPages: number | null;
    totalReviewsCount: number | null;
}

export interface CompanyWatchState {
    version: 1;
    companyUrl: string;
    companyName: string;
    firstObservedAt: string;
    lastObservedAt: string;
    observationCount: number;
    seenReviewIds: string[];
    reviewFirstObservedAt: Record<string, string>;
    reviewObservationCounts: Record<string, number>;
    summary: CompanySummary;
}

export interface MonitoringDecision {
    records: ReviewRecord[];
    nextState: CompanyWatchState;
    companyChangedFields: string[];
    newReviewCount: number;
    seenReviewCount: number;
}

export interface AccessEvidence {
    tier: string;
    source: 'bff' | 'html';
    pagesFetched: number;
    complete: boolean;
    warning?: string;
    gatewayRecovery?: { originalStatusCode: number; originalSource: 'bff'; recoveredSource: 'html'; requestLimit: 1 };
}

export interface CompanyReport {
    companyName: string;
    companyUrl: string;
    accessTier: string | null;
    source: 'bff' | 'html' | null;
    complete: boolean;
    historyCommitted?: boolean;
    collectedReviews: number;
    emittedReviews: number;
    newReviews: number;
    seenReviews: number;
    companyChangedFields: string[];
    warning?: string;
    gatewayRecovery?: AccessEvidence['gatewayRecovery'];
}
