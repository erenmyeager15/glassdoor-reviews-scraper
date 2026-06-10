export interface ActorInput {
    companyUrls?: string[];
    companyNames?: string[];
    maxReviewsPerCompany?: number;
    filterByEmploymentStatus?: '' | 'current' | 'former';
    filterByJobTitle?: string;
    filterByLocation?: string;
    proxyConfiguration?: {
        useApifyProxy: boolean;
        apifyProxyGroups?: string[];
        apifyProxyCountry?: string;
        proxyUrls?: string[];
    };
}

export interface CompanyRecord {
    companyName: string;
    glassdoorUrl: string;
    overallRating: number | null;
    recommendToFriendPct: number | null;
    ceoApprovalPct: number | null;
    totalReviewsCount: number | null;
    scrapedAt: string;
}

export interface ReviewRecord {
    companyName: string;
    companyUrl: string;
    reviewId: string;
    reviewUrl: string | null;
    headline: string | null;
    overallRating: number | null;
    jobTitle: string | null;
    employmentStatus: string | null;
    employmentTenure: string | null;
    location: string | null;
    reviewDate: string | null;
    pros: string | null;
    cons: string | null;
    scrapedAt: string;
}
