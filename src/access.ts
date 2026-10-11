import { Actor } from 'apify';
import { Impit } from 'impit';
import { load } from 'cheerio';
import { CookieJar } from 'tough-cookie';
import { isBlockedGlassdoorPage, normalizeText } from './parser.js';
import { toProxyOptions } from './input.js';
import type { NormalizedInput, ProxyConfigInput } from './types.js';

interface ProxyProvider {
    newUrl(sessionId?: string): Promise<string>;
}

export interface AccessTier {
    label: string;
    proxy?: ProxyProvider;
    stickySession: boolean;
    bootstrap: boolean;
    htmlFallback: boolean;
    requestTimeoutMs: number;
    ignoreTlsErrors: boolean;
}

export interface AccessResponse {
    statusCode: number;
    body: string;
    finalUrl: string;
}

interface ClientState {
    client: Impit;
    bootstrappedOrigins: Set<string>;
}

const clients = new Map<string, ClientState>();

function proxyLabel(value: ProxyConfigInput): string {
    if (value.proxyUrls?.length) return 'custom proxy';
    if (value.useApifyProxy === false) return 'direct';
    if (value.apifyProxyGroups?.length) return `Apify ${value.apifyProxyGroups.join('+')} proxy`;
    return 'Apify datacenter proxy';
}

async function createTier(
    label: string,
    options: ReturnType<typeof toProxyOptions>,
    settings: Pick<AccessTier, 'stickySession' | 'bootstrap' | 'htmlFallback' | 'requestTimeoutMs' | 'ignoreTlsErrors'>,
): Promise<AccessTier> {
    if ('useApifyProxy' in options && options.useApifyProxy === false && !('proxyUrls' in options)) {
        return {
            label: 'direct',
            stickySession: true,
            bootstrap: true,
            htmlFallback: true,
            requestTimeoutMs: 20_000,
            ignoreTlsErrors: false,
        };
    }
    const proxy = await Actor.createProxyConfiguration(options) as ProxyProvider | undefined;
    if (!proxy) throw new Error(`Could not initialize ${label}.`);
    return { label, proxy, ...settings };
}

export async function buildAccessTiers(input: NormalizedInput): Promise<AccessTier[]> {
    if (input.proxyConfiguration) {
        const isUnblocker = input.proxyConfiguration.apifyProxyGroups
            ?.some((group) => group.toUpperCase() === 'UNBLOCKER') === true;
        return [await createTier(
            proxyLabel(input.proxyConfiguration),
            toProxyOptions(input.proxyConfiguration),
            {
                stickySession: !isUnblocker,
                bootstrap: !isUnblocker,
                htmlFallback: !isUnblocker,
                requestTimeoutMs: isUnblocker ? 40_000 : 20_000,
                ignoreTlsErrors: isUnblocker,
            },
        )];
    }

    if (input.useUnblocker) {
        try {
            return [await createTier('Apify Unblocker', {
                useApifyProxy: true,
                groups: ['UNBLOCKER'],
            }, {
                stickySession: false,
                bootstrap: false,
                htmlFallback: false,
                requestTimeoutMs: 40_000,
                ignoreTlsErrors: true,
            })];
        } catch {
            // Cloud runs normally have credentials; diagnostics remain useful without them.
        }
    }
    return [{
        label: 'direct',
        stickySession: true,
        bootstrap: true,
        htmlFallback: true,
        requestTimeoutMs: 20_000,
        ignoreTlsErrors: false,
    }];
}

async function clientFor(tier: AccessTier, sessionId: string): Promise<ClientState> {
    const clientKey = `${tier.label}\n${sessionId}`;
    let state = clients.get(clientKey);
    if (!state) {
        const proxyUrl = tier.proxy
            ? await tier.proxy.newUrl(tier.stickySession ? sessionId : undefined)
            : undefined;
        const client = new Impit({
            browser: 'chrome142',
            ...(proxyUrl ? { proxyUrl } : {}),
            timeout: tier.requestTimeoutMs,
            ignoreTlsErrors: tier.ignoreTlsErrors,
            followRedirects: true,
            maxRedirects: 5,
            cookieJar: new CookieJar(),
            headers: { 'accept-language': 'en-US,en;q=0.9' },
        });
        state = { client, bootstrappedOrigins: new Set() };
        clients.set(clientKey, state);
    }
    return state;
}

async function bootstrapSession(tier: AccessTier, targetUrl: string, sessionId: string): Promise<void> {
    if (!tier.bootstrap) return;
    const origin = new URL(targetUrl).origin;
    const state = await clientFor(tier, sessionId);
    if (state.bootstrappedOrigins.has(origin)) return;
    state.bootstrappedOrigins.add(origin);
    try {
        const response = await state.client.fetch(`${origin}/`, {
            headers: {
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                referer: `${origin}/`,
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': 'none',
            },
        });
        await response.text();
    } catch {
        // The BFF request below provides the useful diagnostic if bootstrap is blocked.
    }
}

async function request(tier: AccessTier, url: string, sessionId: string, options: { method?: 'GET' | 'POST'; body?: string; referer?: string } = {}): Promise<AccessResponse> {
    const { client } = await clientFor(tier, sessionId);
    const origin = new URL(url).origin;
    const response = await client.fetch(url, {
        method: options.method ?? 'GET',
        ...(options.body ? { body: options.body } : {}),
        headers: {
            accept: options.body ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            ...(options.body ? {
                'content-type': 'application/json',
                origin,
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
            } : {}),
            ...(options.referer ? { referer: options.referer } : {}),
        },
    });
    const body = await response.text();
    if (body.length > 12_000_000) throw new Error('Glassdoor response exceeded the 12 MB safety limit.');
    return { statusCode: response.status, body, finalUrl: response.url };
}

export async function fetchHtml(tier: AccessTier, url: string, sessionId: string): Promise<AccessResponse> {
    const response = await request(tier, url, sessionId);
    if (isBlockedGlassdoorPage(response.statusCode, response.body)) {
        throw new Error(`Glassdoor access blocked on ${tier.label} (HTTP ${response.statusCode}).`);
    }
    if (response.statusCode < 200 || response.statusCode >= 400) {
        throw new Error(`Glassdoor returned HTTP ${response.statusCode} on ${tier.label}.`);
    }
    return response;
}

export function buildBffPayload(employerId: number, page: number, pageSize: number): Record<string, unknown> {
    return {
        applyDefaultCriteria: true,
        employerId,
        employmentStatuses: ['REGULAR', 'PART_TIME'],
        jobTitle: null,
        goc: null,
        location: {},
        defaultLanguage: 'eng',
        language: 'eng',
        onlyCurrentEmployees: false,
        overallRating: null,
        pageSize,
        page,
        sort: 'DATE',
        textSearch: '',
        worldwideFilter: false,
        dynamicProfileId: employerId,
        enableKeywordSearch: false,
    };
}

export async function fetchBff(tier: AccessTier, companyUrl: string, employerId: number, page: number, pageSize: number, sessionId: string): Promise<unknown> {
    await bootstrapSession(tier, companyUrl, sessionId);
    const origin = new URL(companyUrl).origin;
    const response = await request(tier, `${origin}/bff/employer-profile-mono/employer-reviews`, sessionId, {
        method: 'POST',
        body: JSON.stringify(buildBffPayload(employerId, page, pageSize)),
        referer: companyUrl,
    });
    if (isBlockedGlassdoorPage(response.statusCode, response.body)) {
        throw new Error(`Glassdoor reviews API blocked on ${tier.label} (HTTP ${response.statusCode}).`);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Glassdoor reviews API returned HTTP ${response.statusCode} on ${tier.label}.`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(response.body);
    } catch {
        throw new Error('Glassdoor reviews API returned non-JSON content.');
    }
    if (parsed && typeof parsed === 'object' && 'errors' in parsed) throw new Error('Glassdoor reviews API returned an application error.');
    return parsed;
}

export async function resolveCompanyName(tiers: AccessTier[], name: string): Promise<string | null> {
    const endpoint = `https://www.glassdoor.com/searchsuggest/typeahead?numSuggestions=8&source=GD_V2&version=NEW&rf=full&fallback=token&input=${encodeURIComponent(name)}`;
    for (let index = 0; index < tiers.length; index++) {
        const tier = tiers[index];
        const sessionId = `search_${index}_${name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'company'}`;
        try {
            await bootstrapSession(tier, endpoint, sessionId);
            const response = await fetchHtml(tier, endpoint, sessionId);
            try {
                const suggestions = JSON.parse(response.body) as Array<Record<string, unknown>>;
                const company = suggestions.find((item) => item.category === 'company' && Number(item.employerId) > 0);
                if (company) {
                    const employerName = normalizeText(company.suggestion) || name;
                    return `https://www.glassdoor.com/Reviews/${encodeURIComponent(employerName.replace(/\s+/g, '-'))}-Reviews-E${Number(company.employerId)}.htm`;
                }
            } catch {
                const $ = load(response.body);
                const href = $('a[href*="-Reviews-E"]').first().attr('href');
                if (href) return new URL(href, 'https://www.glassdoor.com').toString();
            }
        } catch {
            // Try the next approved access tier.
        }
    }
    return null;
}
