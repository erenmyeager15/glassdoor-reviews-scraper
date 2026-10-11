import type { ActorInput, NormalizedInput, ProxyConfigInput } from './types.js';

const GLASSDOOR_HOSTS = new Set([
    'glassdoor.com', 'www.glassdoor.com', 'glassdoor.co.in', 'www.glassdoor.co.in',
    'glassdoor.co.uk', 'www.glassdoor.co.uk', 'glassdoor.ca', 'www.glassdoor.ca',
    'glassdoor.com.au', 'www.glassdoor.com.au', 'glassdoor.ie', 'www.glassdoor.ie',
    'glassdoor.sg', 'www.glassdoor.sg',
]);

function cleanText(value: unknown, maxLength: number): string {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength) : '';
}

function cleanList(value: unknown, maxItems: number, maxLength: number): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

export function normalizeCompanyUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Invalid Glassdoor company URL. Use a complete public company reviews URL.');
    }
    if (url.protocol !== 'https:' || !GLASSDOOR_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) {
        throw new Error('Company URLs must use HTTPS on a supported Glassdoor domain without credentials or a custom port.');
    }
    if (!/\/Reviews\/.+-Reviews-E\d+(?:_P\d+)?\.htm$/i.test(url.pathname)) {
        throw new Error('Use a Glassdoor company reviews-page URL containing its employer ID.');
    }
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/_P\d+(?=\.htm$)/i, '');
    return url.toString();
}

function normalizeProxy(value: unknown): ProxyConfigInput | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('proxyConfiguration must be an object.');
    const raw = value as ProxyConfigInput;
    const proxyUrls = cleanList(raw.proxyUrls, 20, 2_000);
    const groups = cleanList(raw.apifyProxyGroups, 10, 100);
    if (proxyUrls.length && (raw.useApifyProxy === true || groups.length)) {
        throw new Error('Do not combine custom proxy URLs with Apify Proxy groups.');
    }
    if (proxyUrls.length) return { useApifyProxy: false, proxyUrls };
    if (raw.useApifyProxy === false) return { useApifyProxy: false };
    return {
        useApifyProxy: true,
        ...(groups.length ? { apifyProxyGroups: groups } : {}),
        ...(cleanText(raw.apifyProxyCountry, 2) ? { apifyProxyCountry: cleanText(raw.apifyProxyCountry, 2).toUpperCase() } : {}),
    };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    }
    return parsed;
}

export function normalizeInput(input: ActorInput): NormalizedInput {
    if (Array.isArray(input.companyUrls) && input.companyUrls.length > 20) throw new Error('A run can contain at most 20 company URLs.');
    if (Array.isArray(input.companyNames) && input.companyNames.length > 20) throw new Error('A run can contain at most 20 company names.');
    const companyUrls = cleanList(input.companyUrls, 20, 2_000).map(normalizeCompanyUrl);
    const companyNames = cleanList(input.companyNames, 20, 120);
    if (companyUrls.length + companyNames.length === 0) {
        throw new Error('Provide at least one Glassdoor company reviews URL or company name.');
    }
    if (companyUrls.length + companyNames.length > 20) throw new Error('A run can contain at most 20 companies.');

    const status = cleanText(input.filterByEmploymentStatus, 20).toLowerCase();
    if (!['', 'current', 'former'].includes(status)) throw new Error('filterByEmploymentStatus must be current, former, or empty.');

    return {
        companyUrls,
        companyNames,
        maxReviewsPerCompany: boundedInteger(input.maxReviewsPerCompany, 3, 1, 500, 'maxReviewsPerCompany'),
        filterByEmploymentStatus: status as '' | 'current' | 'former',
        filterByJobTitle: cleanText(input.filterByJobTitle, 120).toLowerCase(),
        filterByLocation: cleanText(input.filterByLocation, 120).toLowerCase(),
        watchlistName: cleanText(input.watchlistName, 80) || 'default',
        onlyNewReviews: input.onlyNewReviews === true,
        useUnblocker: input.useUnblocker
            ?? input.allowUnblockerFallback
            ?? input.allowResidentialFallback
            ?? true,
        maxRunMinutes: boundedInteger(input.maxRunMinutes, 5, 1, 15, 'maxRunMinutes'),
        proxyConfiguration: normalizeProxy(input.proxyConfiguration),
    };
}

export function toProxyOptions(value: ProxyConfigInput) {
    if (value.proxyUrls?.length) return { proxyUrls: [...value.proxyUrls] };
    if (value.useApifyProxy === false) return { useApifyProxy: false };
    return {
        useApifyProxy: true,
        ...(value.apifyProxyGroups?.length ? { groups: [...value.apifyProxyGroups] } : {}),
        ...(value.apifyProxyCountry ? { countryCode: value.apifyProxyCountry } : {}),
    };
}
