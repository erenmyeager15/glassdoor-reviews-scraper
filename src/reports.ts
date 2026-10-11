import type { CompanyReport, ReviewRecord } from './types.js';

function safeCell(value: unknown): string {
    const text = Array.isArray(value) ? value.join('|') : value == null ? '' : String(value);
    const protectedText = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${protectedText.replace(/"/g, '""')}"`;
}

export function buildCsv(records: ReviewRecord[]): string {
    const fields: Array<keyof ReviewRecord> = [
        'companyName', 'companyUrl', 'employerId', 'reviewId', 'reviewUrl', 'reviewDate', 'overallRating', 'ratingBand',
        'ratingWorkLifeBalance', 'ratingCultureAndValues', 'ratingDiversityAndInclusion', 'ratingSeniorLeadership',
        'ratingCareerOpportunities', 'ratingCompensationAndBenefits', 'recommendToFriend', 'ceoApproval', 'businessOutlook',
        'headline', 'pros', 'cons', 'adviceToManagement', 'jobTitle', 'employmentStatus', 'employmentType', 'isCurrentEmployee',
        'employmentTenure', 'employmentTenureYears', 'location', 'employerResponse', 'employerResponseDate', 'helpfulCount', 'notHelpfulCount',
        'featured', 'topics', 'dataQualityWarnings', 'watchlistName', 'monitoringStatus', 'firstObservedAt', 'observationCount',
        'companyChangeDetected', 'companyChangedFields', 'sourceQuality', 'scrapedAt',
    ];
    const lines = [fields.map(safeCell).join(',')];
    for (const record of records) lines.push(fields.map((field) => safeCell(record[field])).join(','));
    return `${lines.join('\n')}\n`;
}

export function buildMarkdown(reports: CompanyReport[], emitted: number, newReviews: number): string {
    const lines = [
        '# Glassdoor monitoring report',
        '',
        `- Reviews emitted: **${emitted}**`,
        `- Newly observed reviews: **${newReviews}**`,
        `- Companies processed: **${reports.length}**`,
        '',
        '| Company | Source | Access | Collected | Emitted | New | Company changes | Status |',
        '|---|---|---|---:|---:|---:|---|---|',
    ];
    for (const report of reports) {
        const clean = (value: string) => value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
        lines.push(`| ${clean(report.companyName)} | ${report.source ?? '-'} | ${clean(report.accessTier ?? '-')} | ${report.collectedReviews} | ${report.emittedReviews} | ${report.newReviews} | ${clean(report.companyChangedFields.join(', ') || '-')} | ${report.complete ? 'complete' : 'partial'} |`);
    }
    lines.push('', 'Company and review changes are based on this private named watchlist. Missing or blocked pages are never treated as deletions.');
    return `${lines.join('\n')}\n`;
}
