import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import type { ActorInput } from './types.js';
import { buildHandler } from './routes.js';

function searchUrl(name: string): string {
    return `https://www.glassdoor.com/Search/results.htm?keyword=${encodeURIComponent(name)}`;
}

Actor.main(async () => {
    const input = ((await Actor.getInput<ActorInput>()) ?? {}) as ActorInput;

    const companyUrls = (input.companyUrls ?? []).filter((u) => typeof u === 'string' && u.trim());
    const companyNames = (input.companyNames ?? []).filter((n) => typeof n === 'string' && n.trim());

    if (companyUrls.length === 0 && companyNames.length === 0) {
        log.error('No input. Provide companyUrls (Glassdoor reviews page URLs) or companyNames.');
        return;
    }

    log.info(`Starting Glassdoor scrape: ${companyUrls.length} URL(s), ${companyNames.length} name(s)`);

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
        maxConcurrency: 2,
        minConcurrency: 1,
        maxRequestsPerMinute: 20,
        navigationTimeoutSecs: 90,
        requestHandlerTimeoutSecs: 240,
        maxRequestRetries: 8,
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
