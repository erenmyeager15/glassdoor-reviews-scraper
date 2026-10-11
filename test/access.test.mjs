import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { Actor } from 'apify';
import { buildAccessTiers, fetchHtml, requestLimits, UNBLOCKER_REQUEST_TIMEOUT_MS } from '../dist/access.js';
import { normalizeInput } from '../dist/input.js';

const companyUrl = 'https://www.glassdoor.com/Reviews/Example-Reviews-E123.htm';
async function withProxyFactory(callback) {
    const original = Actor.createProxyConfiguration;
    const calls = [];
    Actor.createProxyConfiguration = async options => {
        calls.push(options);
        return { newUrl: async () => 'http://localhost:9999' };
    };
    try { await callback(calls); } finally { Actor.createProxyConfiguration = original; }
}

test('automatic Unblocker has bounded latency headroom and still only one sessionless route', async () => {
    await withProxyFactory(async calls => {
        const tiers = await buildAccessTiers(normalizeInput({ companyUrls: [companyUrl] }));
        assert.deepEqual(calls, [{ useApifyProxy: true, groups: ['UNBLOCKER'] }]);
        assert.equal(tiers.length, 1);
        assert.equal(tiers[0].label, 'Apify Unblocker');
        assert.equal(tiers[0].requestTimeoutMs, 75_000);
        assert.equal(tiers[0].stickySession, false);
        assert.equal(tiers[0].bootstrap, false);
        assert.equal(tiers[0].htmlFallback, false);
    });
});

test('explicit Unblocker gets the same timeout without introducing a fallback or changing its country', async () => {
    await withProxyFactory(async calls => {
        const tiers = await buildAccessTiers(normalizeInput({ companyUrls: [companyUrl],
            proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['UNBLOCKER'], apifyProxyCountry: 'US' } }));
        assert.deepEqual(calls, [{ useApifyProxy: true, groups: ['UNBLOCKER'], countryCode: 'US' }]);
        assert.equal(tiers.length, 1);
        assert.equal(tiers[0].requestTimeoutMs, UNBLOCKER_REQUEST_TIMEOUT_MS);
        assert.equal(tiers[0].bootstrap, false);
        assert.equal(tiers[0].htmlFallback, false);
        assert.equal(tiers[0].stickySession, false);
    });
});

test('ordinary explicit direct access retains its existing timeout and TLS verification', async () => {
    await withProxyFactory(async calls => {
        const tiers = await buildAccessTiers(normalizeInput({ companyUrls: [companyUrl],
            proxyConfiguration: { useApifyProxy: false } }));
        assert.equal(calls.length, 0);
        assert.equal(tiers.length, 1);
        assert.equal(tiers[0].requestTimeoutMs, 20_000);
        assert.equal(tiers[0].ignoreTlsErrors, false);
    });
});

test('one shared native timeout/abort window stays bounded by the total collection deadline', () => {
    const tier = { requestTimeoutMs: UNBLOCKER_REQUEST_TIMEOUT_MS };
    const normal = requestLimits(tier, Infinity, 1_000);
    assert.equal(normal.timeout, 75_000);
    assert.ok(normal.signal instanceof AbortSignal);
    const shortened = requestLimits(tier, 46_000, 1_000);
    assert.equal(shortened.timeout, 45_000);
    assert.ok(shortened.signal instanceof AbortSignal);
    assert.throws(() => requestLimits(tier, 1_000, 1_000), /run-time limit/);
});

test('native Impit aborts at a short deadline but accepts a slower response within its bounded window', async () => {
    // Synthetic loopback fixture only: no Glassdoor request or paid proxy traffic.
    const server = http.createServer((request, response) => {
        setTimeout(() => { response.writeHead(200, { 'content-type': 'text/html' });
            response.end('<html><body>Synthetic delayed response</body></html>'); }, 80);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/synthetic`;
    const tier = { label: `loopback-${server.address().port}`, stickySession: false, bootstrap: false,
        htmlFallback: false, requestTimeoutMs: 300, ignoreTlsErrors: false };
    try {
        await assert.rejects(fetchHtml(tier, url, 'short-window', Date.now() + 35), /timeout|timed out|run-time limit/i);
        const response = await fetchHtml(tier, url, 'longer-window', Date.now() + 1_000);
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /Synthetic delayed response/);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
