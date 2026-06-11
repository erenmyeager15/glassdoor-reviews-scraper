import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import type { ActorInput } from './types.js';
import { buildHandler } from './routes.js';

interface BrowserCookie {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    url?: string;
}

function normalizeSameSite(value: unknown): BrowserCookie['sameSite'] {
    if (typeof value !== 'string') return undefined;
    const normalized = value.toLowerCase();
    if (normalized === 'strict') return 'Strict';
    if (normalized === 'lax') return 'Lax';
    if (normalized === 'none' || normalized === 'no_restriction') return 'None';
    return undefined;
}

function searchUrl(name: string): string {
    return `https://www.glassdoor.com/Search/results.htm?keyword=${encodeURIComponent(name)}`;
}

function parseGlassdoorCookies(rawCookies: string | undefined): BrowserCookie[] {
    const trimmed = rawCookies?.trim();
    if (!trimmed) return [];

    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
            return parsed
                .filter((cookie): cookie is Record<string, unknown> => Boolean(cookie && typeof cookie === 'object'))
                .map((cookie): BrowserCookie => {
                    const normalized: BrowserCookie = {
                        name: String(cookie.name ?? ''),
                        value: String(cookie.value ?? ''),
                        domain: typeof cookie.domain === 'string' ? cookie.domain : '.glassdoor.com',
                        path: typeof cookie.path === 'string' ? cookie.path : '/',
                        secure: typeof cookie.secure === 'boolean' ? cookie.secure : true,
                    };
                    if (typeof cookie.expires === 'number') normalized.expires = cookie.expires;
                    if (typeof cookie.expirationDate === 'number') normalized.expires = cookie.expirationDate;
                    if (typeof cookie.httpOnly === 'boolean') normalized.httpOnly = cookie.httpOnly;
                    const sameSite = normalizeSameSite(cookie.sameSite);
                    if (sameSite) normalized.sameSite = sameSite;
                    if (typeof cookie.url === 'string') normalized.url = cookie.url;
                    return normalized;
                })
                .filter((cookie) => cookie.name && cookie.value);
        }
    } catch {
        // Fall back to Cookie header format below.
    }

    return trimmed
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part): BrowserCookie | null => {
            const separator = part.indexOf('=');
            if (separator <= 0) return null;
            const name = part.slice(0, separator).trim();
            if (/^(path|domain|expires|max-age|samesite)$/i.test(name)) return null;

            return {
                name,
                value: part.slice(separator + 1).trim(),
                domain: '.glassdoor.com',
                path: '/',
                secure: true,
            };
        })
        .filter((cookie): cookie is BrowserCookie => Boolean(cookie?.name && cookie.value));
}

Actor.main(async () => {
    const input = ((await Actor.getInput<ActorInput>()) ?? {}) as ActorInput;
    const glassdoorCookies = parseGlassdoorCookies(input.glassdoorCookies);

    const companyUrls = (input.companyUrls ?? []).filter((u) => typeof u === 'string' && u.trim());
    const companyNames = (input.companyNames ?? []).filter((n) => typeof n === 'string' && n.trim());

    if (companyUrls.length === 0 && companyNames.length === 0) {
        log.error('No input. Provide companyUrls (Glassdoor reviews page URLs) or companyNames.');
        return;
    }

    log.info(`Starting Glassdoor scrape: ${companyUrls.length} URL(s), ${companyNames.length} name(s)`);
    log.info(glassdoorCookies.length
        ? `Loaded ${glassdoorCookies.length} Glassdoor auth cookie(s); pagination is enabled.`
        : 'No Glassdoor auth cookies supplied; anonymous run will scrape public page-1 reviews only.');

    // Glassdoor is behind a Cloudflare managed challenge - residential proxies + a real
    // (xvfb-headed) browser are required. Default to Apify residential proxies.
    const proxyConfiguration = await Actor.createProxyConfiguration(
        input.proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'US' },
    );

    const requests = [
        ...companyUrls.map((url) => ({
            url: url.trim(),
            userData: { label: 'COMPANY' as const, companyUrl: url.trim(), pageNum: 1, collectedIds: [] as string[] },
        })),
        ...companyNames.map((name) => ({
            url: searchUrl(name.trim()),
            userData: { label: 'SEARCH' as const, companyName: name.trim() },
        })),
    ];

    const handler = buildHandler(input);

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        requestHandler: handler,
        headless: false, // run headed under Apify's xvfb so Cloudflare's challenge clears
        preNavigationHooks: [
            async ({ page }) => {
                if (!glassdoorCookies.length) return;
                await page.context().addCookies(glassdoorCookies.map((cookie) => ({
                    ...cookie,
                    url: cookie.url ?? (cookie.domain ? undefined : 'https://www.glassdoor.com'),
                })));
            },
        ],
        maxConcurrency: 2,
        minConcurrency: 1,
        maxRequestsPerMinute: 20,
        navigationTimeoutSecs: 90,
        requestHandlerTimeoutSecs: 240,
        maxRequestRetries: 3,
        sessionPoolOptions: {
            maxPoolSize: 30,
            // Cloudflare serves the interstitial with a 403; don't retire sessions on it -
            // the browser solves the challenge in-page (handled by clearCloudflare()).
            blockedStatusCodes: [],
            sessionOptions: { maxAgeSecs: 1800, maxUsageCount: 15 },
        },
        browserPoolOptions: { useFingerprints: true },
        launchContext: {
            useChrome: true,
            launchOptions: {
                args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
            },
        },
        failedRequestHandler: async ({ request, log: l, error }) => {
            l.error(`Request failed after retries: ${request.url} - ${(error as Error)?.message ?? error}`);
        },
    });

    await crawler.run(requests);
    log.info('Glassdoor scrape finished.');
});
