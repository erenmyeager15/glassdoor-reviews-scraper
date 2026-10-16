import assert from 'node:assert/strict';
import test from 'node:test';
import { runGlassdoor } from '../dist/collector.js';
import { normalizeCompanyUrl } from '../dist/input.js';
import { requestTimeout, GlassdoorHttpError } from '../dist/access.js';

const companyUrl = 'https://www.glassdoor.com/Reviews/Example-Co-Reviews-E123.htm';
const secondCompanyUrl = 'https://www.glassdoor.com/Reviews/Another-Co-Reviews-E124.htm';
function page(ids = [1], options = {}) {
    return { data: { employerReviews: {
        employer: { id: 123, shortName: 'Example Co', links: { reviewsUrl: companyUrl } },
        currentPage: options.currentPage ?? 1, numberOfPages: options.pages ?? 1,
        allReviewsCount: options.total ?? ids.length, ratings: { overallRating: 4.2 },
        reviews: ids.map(id => ({ reviewId: id, ratingOverall: 4, pros: 'Useful work', cons: 'Long hours',
            summary: `Review ${id}`, reviewDateTime: '2026-10-11', isCurrentJob: true })),
    } } };
}
function harness(pages, budget = Infinity) {
    let remaining = budget;
    const values = new Map();
    const rows = [];
    const calls = { access: 0, store: 0, requests: [], resolution: 0, writes: 0, warnings: [] };
    const state = new Map();
    const runtime = {
        now: () => Date.parse('2026-10-11T10:00:00.000Z'),
        buildAccessTiers: async () => { calls.access++; return [{ label: 'offline', htmlFallback: false }]; },
        fetchBff: async (...args) => {
            calls.requests.push(args);
            assert.ok(pages.length, 'Unexpected extra paid page');
            const next = pages.shift();
            if (next instanceof Error) throw next;
            return next;
        },
        fetchHtml: async () => { throw new Error('Unexpected HTML fallback'); },
        resolveCompanyName: async () => { calls.resolution++; return companyUrl; },
        remainingReviews: () => remaining,
        pushReview: async row => { assert.ok(remaining > 0, 'Exhausted budget must never be overcharged');
            rows.push(row); remaining--; return { chargedCount: 1, eventChargeLimitReached: false }; },
        openWatchStore: async () => { calls.store++; return { id: 'offline-watchlist',
            getValue: async key => state.get(key) ?? null,
            setValue: async (key, value) => { calls.writes++; state.set(key, structuredClone(value)); },
        }; },
        setValue: async (key, value) => { values.set(key, structuredClone(value)); },
        setStatus: async () => {},
        warn: message => { calls.warnings.push(message); },
    };
    return { runtime, calls, rows, values, state };
}
const input = overrides => ({ companyUrls: [companyUrl], maxReviewsPerCompany: 1, ...overrides });

test('whole default collection saves valid output and all report formats', async () => {
    const check = harness([page()]);
    const output = await runGlassdoor(input({}), check.runtime);
    assert.equal(output.status, 'COMPLETE');
    assert.equal(check.rows.length, 1);
    assert.equal(check.calls.writes, 1);
    assert.match(check.values.get('MONITORING-REPORT.csv'), /Useful work/);
    assert.match(check.values.get('MONITORING-REPORT.md'), /Example Co/);
});

test('exhausted budget prevents access setup, company resolution, source traffic and history', async () => {
    const check = harness([], 0);
    const output = await runGlassdoor(input({ companyNames: ['Example Co'] }), check.runtime);
    assert.equal(output.status, 'BUDGET_LIMITED');
    assert.equal(output.reviewsEmitted, 0);
    assert.equal(check.calls.access, 0);
    assert.equal(check.calls.resolution, 0);
    assert.equal(check.calls.store, 0);
    assert.equal(check.calls.requests.length, 0);
});

test('later page failure keeps already-collected valid reviews as partial without advancing history', async () => {
    const check = harness([page([1], { pages: 2, total: 2 }), new Error('Source temporarily blocked')]);
    const output = await runGlassdoor(input({ maxReviewsPerCompany: 2 }), check.runtime);
    assert.equal(output.status, 'PARTIAL');
    assert.equal(check.rows.length, 1);
    assert.equal(check.rows[0].sourceQuality, 'partial');
    assert.equal(check.calls.writes, 0);
    assert.equal(output.completedCompanies, 0);
});

test('budget cap never downloads another company or marks an undersized sample complete', async () => {
    const check = harness([page([1, 2], { pages: 1, total: 2 })], 1);
    const output = await runGlassdoor(input({ companyUrls: [companyUrl, secondCompanyUrl], maxReviewsPerCompany: 2 }), check.runtime);
    assert.equal(output.status, 'BUDGET_LIMITED');
    assert.equal(check.rows.length, 1);
    assert.equal(check.rows[0].sourceQuality, 'partial');
    assert.equal(check.calls.requests.length, 1);
    assert.equal(check.calls.writes, 0);
});

test('state-write failure cannot be labeled COMPLETE', async () => {
    const check = harness([page()]);
    const open = check.runtime.openWatchStore;
    check.runtime.openWatchStore = async () => ({ ...await open(), setValue: async () => { throw new Error('Storage unavailable'); } });
    const output = await runGlassdoor(input({}), check.runtime);
    assert.equal(output.status, 'PARTIAL');
    assert.equal(output.stateWriteFailures, 1);
    assert.equal(check.rows.length, 1);
});

test('unresolved company names make an otherwise good run PARTIAL', async () => {
    const check = harness([page()]);
    check.runtime.resolveCompanyName = async () => null;
    const output = await runGlassdoor(input({ companyNames: ['Unknown Co'] }), check.runtime);
    assert.equal(output.status, 'PARTIAL');
    assert.equal(output.failedCompanies, 1);
});

test('a report export failure never advances the monitoring baseline', async () => {
    const check = harness([page()]);
    const save = check.runtime.setValue;
    check.runtime.setValue = async (key, value) => {
        if (key === 'MONITORING-REPORT.csv') throw new Error('CSV storage unavailable');
        return save(key, value);
    };
    const output = await runGlassdoor(input({}), check.runtime);
    assert.equal(output.status, 'FAILED');
    assert.equal(output.failureStage, 'REPORT_EXPORT');
    assert.equal(check.rows.length, 1);
    assert.equal(check.calls.writes, 0);
});

test('an output billing error keeps saved row evidence and stops other companies without history commits', async () => {
    const check = harness([page([1, 2])]);
    const push = check.runtime.pushReview;
    check.runtime.pushReview = async row => {
        if (check.rows.length) throw new Error('Billing service failed');
        return push(row);
    };
    const output = await runGlassdoor(input({ maxReviewsPerCompany: 2, companyUrls: [companyUrl, secondCompanyUrl] }), check.runtime);
    assert.equal(output.status, 'FAILED');
    assert.equal(output.failureStage, 'OUTPUT_BILLING');
    assert.equal(output.reviewsEmitted, 1);
    assert.equal(output.failedCompanies, 0);
    assert.equal(check.calls.requests.length, 1);
    assert.equal(check.calls.writes, 0);
});

test('total source outage remains FAILED with no fabricated review rows', async () => {
    const check = harness([new Error('HTTP 403 blocked')]);
    const output = await runGlassdoor(input({}), check.runtime);
    assert.equal(output.status, 'FAILED');
    assert.equal(output.failedCompanies, 1);
    assert.equal(check.rows.length, 0);
    assert.equal(check.calls.writes, 0);
});

test('an SDK rejected push is not saved, charged twice or committed to history', async () => {
    const check = harness([page()]);
    check.runtime.pushReview = async () => ({ chargedCount: 0, eventChargeLimitReached: true });
    const output = await runGlassdoor(input({}), check.runtime);
    assert.equal(output.status, 'BUDGET_LIMITED');
    assert.equal(output.reviewsEmitted, 0);
    assert.equal(check.calls.writes, 0);
});

test('the final delivered row at an exact budget can commit its complete observation', async () => {
    const check = harness([page()], 1);
    const output = await runGlassdoor(input({}), check.runtime);
    assert.equal(output.reviewsEmitted, 1);
    assert.equal(check.calls.writes, 1);
    assert.equal(check.values.get('MONITORING-REPORT').companies[0].historyCommitted, true);
});

test('free and non-monetized saved rows remain usable despite a zero charged count', async () => {
    const check = harness([page()]);
    check.runtime.pushReview = async row => { check.rows.push(row); return { chargedCount: 0, eventChargeLimitReached: false }; };
    const output = await runGlassdoor(input({}), check.runtime);
    assert.equal(output.status, 'COMPLETE');
    assert.equal(output.reviewsEmitted, 1);
});

test('invalid budget readings fail before access work', async () => {
    for (const budget of [NaN, -1, -Infinity]) {
        const check = harness([]);
        check.runtime.remainingReviews = () => budget;
        await assert.rejects(runGlassdoor(input({}), check.runtime), /Invalid remaining review budget/);
        assert.equal(check.calls.access, 0);
    }
});

test('repeated reviews pages stop as partial instead of becoming a complete baseline', async () => {
    const check = harness([page([1], { pages: 3, total: 3 }), page([1], { pages: 3, total: 3 })]);
    const output = await runGlassdoor(input({ maxReviewsPerCompany: 3 }), check.runtime);
    assert.equal(output.status, 'PARTIAL');
    assert.equal(check.rows.length, 1);
    assert.equal(check.calls.writes, 0);
    assert.equal(check.calls.requests.length, 2);
});

test('two whole watchlist runs preserve history and only-new mode emits no duplicate rows', async () => {
    const check = harness([page([1]), page([1])]);
    const first = await runGlassdoor(input({}), check.runtime);
    const repeat = await runGlassdoor(input({ onlyNewReviews: true }), check.runtime);
    assert.equal(first.status, 'COMPLETE');
    assert.equal(repeat.status, 'COMPLETE');
    assert.equal(check.rows.length, 1);
    assert.equal(repeat.reviewsEmitted, 0);
    assert.equal(check.calls.writes, 2);
    assert.equal([...check.state.values()][0].observationCount, 2);
});

test('no fallback or next company is requested after the run-time deadline', async () => {
    const check = harness([new Error('Request timeout')]);
    const now = check.runtime.now();
    let expired = false;
    check.runtime.now = () => now + (expired ? 60000 : 0);
    check.runtime.buildAccessTiers = async () => [{ label: 'offline', htmlFallback: true }];
    const fetch = check.runtime.fetchBff;
    check.runtime.fetchBff = async (...args) => { expired = true; return fetch(...args); };
    const output = await runGlassdoor(input({ maxRunMinutes: 1, companyUrls: [companyUrl, secondCompanyUrl] }), check.runtime);
    assert.equal(output.status, 'FAILED');
    assert.equal(check.calls.requests.length, 1);
});

test('request timeouts respect the remaining total-run time', () => {
    const tier = { requestTimeoutMs: 40000 };
    assert.equal(requestTimeout(tier, 15000, 5000), 10000);
    assert.equal(requestTimeout(tier, Infinity, 5000), 40000);
    assert.throws(() => requestTimeout(tier, 5000, 5000), /run-time limit/);
});

test('invalid and credentialed URLs never leak submitted secrets into errors', () => {
    const secret = 'DO_NOT_LOG_ME';
    for (const url of [`bad:${secret}`, `https://${secret}:password@www.glassdoor.com/Reviews/A-Reviews-E1.htm`,
        `https://www.glassdoor.com/Overview/A.htm?token=${secret}`, `https://www.glassdoor.com:444/Reviews/A-Reviews-E1.htm`]) {
        assert.throws(() => normalizeCompanyUrl(url), error => !error.message.includes(secret));
    }
});

test('a post-commit report error reports the actual committed company rather than claiming rollback', async () => {
    const check = harness([page()]);
    const save = check.runtime.setValue;
    let reportsWritten = 0;
    check.runtime.setValue = async (key, value) => {
        if (key === 'MONITORING-REPORT' && ++reportsWritten === 2) throw new Error('Post-commit report unavailable');
        return save(key, value);
    };
    const output = await runGlassdoor(input({}), check.runtime);
    assert.equal(output.status, 'FAILED');
    assert.equal(output.failureStage, 'REPORT_EXPORT');
    assert.equal(check.calls.writes, 1);
    assert.deepEqual(output.historyCommittedCompanies, [companyUrl]);
});

test('explicit HTML fallback also retains earlier rows when a later page fails', async () => {
    const check = harness([new Error('Reviews API unavailable')]);
    check.runtime.buildAccessTiers = async () => [{ label: 'explicit offline proxy', htmlFallback: true }];
    let htmlRequests = 0;
    check.runtime.fetchHtml = async () => {
        htmlRequests++;
        if (htmlRequests > 1) throw new Error('HTML page blocked');
        return { statusCode: 200, finalUrl: companyUrl, body: `<h1>Example Co Reviews</h1>
            <article data-test="review-detail" data-brandviews="review_id=1"><div data-test="review-rating-label">4</div>
            <a href="/Reviews/Employee-Review-Example-Co-RVW1.htm"><h3>Useful work</h3></a>
            <div data-test="review-text-PROS">Good team</div></article><a href="/Reviews/Example-Co-Reviews-E123_P2.htm">2</a>` };
    };
    const output = await runGlassdoor(input({ maxReviewsPerCompany: 2 }), check.runtime);
    assert.equal(output.status, 'PARTIAL');
    assert.equal(check.rows.length, 1);
    assert.equal(check.calls.writes, 0);
    assert.equal(htmlRequests, 2);
});

test('a genuine empty review response completes with zero rows rather than inventing a block failure', async () => {
    const check = harness([page([])]);
    const output = await runGlassdoor(input({}), check.runtime);
    assert.equal(output.status, 'COMPLETE');
    assert.equal(output.reviewsEmitted, 0);
    assert.equal(output.failedCompanies, 0);
});

test('source and output error diagnostics redact credentialed URLs and secrets', async () => {
    const check = harness([new Error('Proxy failed at https://account:PRIVATE_SECRET@proxy.example/?token=PRIVATE_SECRET password=PRIVATE_SECRET')]);
    const output = await runGlassdoor(input({}), check.runtime);
    assert.equal(output.status, 'FAILED');
    assert.ok(!JSON.stringify(output).includes('PRIVATE_SECRET'));
    assert.ok(!check.calls.warnings.join(' ').includes('PRIVATE_SECRET'));
});

function recoveryHtml(ids = [11, 12, 13], morePages = false) {
    return `<h1>Example Co Reviews</h1>${ids.map(id => `<article data-test="review-detail" data-brandviews="review_id=${id}">
        <div data-test="review-rating-label">4</div><a href="/Reviews/Employee-Review-Example-Co-RVW${id}.htm"><h3>Useful work ${id}</h3></a>
        <div data-test="review-text-PROS">Helpful team</div></article>`).join('')}
        ${morePages ? '<a href="/Reviews/Example-Co-Reviews-E123_P2.htm">2</a>' : ''}`;
}
function managedRecoveryFixture(errors, body = recoveryHtml()) {
    const check = harness(errors);
    check.runtime.buildAccessTiers = async () => { check.calls.access++; return [{ label: 'offline Unblocker',
        htmlFallback: false, gatewayHtmlRecovery: true }]; };
    check.htmlCalls = [];
    check.runtime.fetchHtml = async (...args) => { check.htmlCalls.push(args); return { statusCode: 200, finalUrl: companyUrl, body }; };
    return check;
}
for (const status of [502, 503, 504]) test(`one same-route public HTML request recovers initial reviews API HTTP ${status}`, async () => {
    const check = managedRecoveryFixture([new GlassdoorHttpError(status, 'bff', 'gateway', 'offline Unblocker')]);
    const result = await runGlassdoor(input({ maxReviewsPerCompany: 3 }), check.runtime);
    assert.equal(result.status, 'COMPLETE'); assert.equal(result.reviewsEmitted, 3);
    assert.equal(check.calls.requests.length, 1); assert.equal(check.htmlCalls.length, 1); assert.equal(check.calls.writes, 1);
    assert.equal(result.gatewayRecoveriesAttempted, 1); assert.equal(result.gatewayRecoveriesSucceeded, 1);
    const report = check.values.get('MONITORING-REPORT').companies[0];
    assert.equal(report.source, 'html'); assert.equal(report.gatewayRecovery.originalStatusCode, status);
    assert.equal(report.gatewayRecovery.requestLimit, 1); assert.match(report.warning, /recovered using one public HTML/);
});
for (const status of [401, 403, 407, 412, 429, 451]) test(`managed access does not recover blocked/rate-limited HTTP ${status}`, async () => {
    const check = managedRecoveryFixture([new GlassdoorHttpError(status, 'bff', 'blocked', 'offline Unblocker')]);
    const result = await runGlassdoor(input({}), check.runtime);
    assert.equal(result.status, 'FAILED'); assert.equal(check.htmlCalls.length, 0); assert.equal(check.rows.length, 0);
});
for (const error of [new Error('HTTP 502'), new Error('Request timeout'),
    new GlassdoorHttpError(502, 'bff', 'blocked', 'offline Unblocker'),
    new GlassdoorHttpError(500, 'bff', 'http', 'offline Unblocker'),
    new GlassdoorHttpError(502, 'html', 'gateway', 'offline Unblocker')]) {
    test(`untrusted error text, timeout, denial or wrong operation cannot trigger recovery: ${error.name}/${error.message}`, async () => {
        const check = managedRecoveryFixture([error]);
        const result = await runGlassdoor(input({}), check.runtime);
        assert.equal(result.status, 'FAILED'); assert.equal(check.htmlCalls.length, 0);
    });
}
test('managed recovery fetches only one HTML page and holds partial history', async () => {
    const check = managedRecoveryFixture([new GlassdoorHttpError(502, 'bff', 'gateway', 'offline')], recoveryHtml([11], true));
    const result = await runGlassdoor(input({ maxReviewsPerCompany: 3 }), check.runtime);
    assert.equal(result.status, 'PARTIAL'); assert.equal(result.reviewsEmitted, 1); assert.equal(check.htmlCalls.length, 1);
    assert.equal(check.calls.writes, 0); assert.equal(check.rows[0].sourceQuality, 'partial');
});
test('a second company cannot consume another managed gateway recovery', async () => {
    const check = managedRecoveryFixture([new GlassdoorHttpError(502, 'bff', 'gateway', 'offline'), new GlassdoorHttpError(503, 'bff', 'gateway', 'offline')]);
    const result = await runGlassdoor(input({ companyUrls: [companyUrl, secondCompanyUrl] }), check.runtime);
    assert.equal(result.status, 'PARTIAL'); assert.equal(result.failedCompanies, 1); assert.equal(check.htmlCalls.length, 1);
    assert.equal(result.gatewayRecoveriesAttempted, 1); assert.equal(check.calls.requests.length, 2);
});
for (const body of ['<html>Client shell without reviews</html>', '<script>{"employerReviews":{}}</script>',
    '<article data-test="review-detail" data-brandviews="review_id=11"></article>']) {
    test(`a recovery shell/empty review is not a fabricated successful result: ${body.slice(0, 40)}`, async () => {
        const check = managedRecoveryFixture([new GlassdoorHttpError(502, 'bff', 'gateway', 'offline')], body);
        const result = await runGlassdoor(input({}), check.runtime);
        assert.equal(result.status, 'FAILED'); assert.equal(result.reviewsEmitted, 0); assert.equal(check.calls.writes, 0);
        assert.equal(check.htmlCalls.length, 1); assert.equal(result.gatewayRecoveriesSucceeded, 0);
    });
}
test('failure of the single recovery does not retry or fabricate rows', async () => {
    const check = managedRecoveryFixture([new GlassdoorHttpError(502, 'bff', 'gateway', 'offline')]);
    check.runtime.fetchHtml = async (...args) => { check.htmlCalls.push(args); throw new Error('Recovery HTTP 502'); };
    const result = await runGlassdoor(input({}), check.runtime);
    assert.equal(result.status, 'FAILED'); assert.equal(check.htmlCalls.length, 1); assert.equal(check.calls.requests.length, 1);
    assert.equal(result.reviewsEmitted, 0); assert.match(result.failures[0].reason, /Single gateway HTML recovery/);
});
test('gateway recovery stops when the original request has consumed the total deadline', async () => {
    const check = managedRecoveryFixture([new GlassdoorHttpError(502, 'bff', 'gateway', 'offline')]);
    const started = check.runtime.now(); let late = false;
    check.runtime.now = () => started + (late ? 60_000 : 0);
    const original = check.runtime.fetchBff;
    check.runtime.fetchBff = async (...args) => { late = true; return original(...args); };
    const result = await runGlassdoor(input({ maxRunMinutes: 1 }), check.runtime);
    assert.equal(result.status, 'FAILED'); assert.equal(check.htmlCalls.length, 0); assert.equal(result.gatewayRecoveriesAttempted, 0);
});
test('exhausted review capacity prevents gateway recovery traffic', async () => {
    const check = managedRecoveryFixture([new GlassdoorHttpError(502, 'bff', 'gateway', 'offline')]);
    let exhausted = false; check.runtime.remainingReviews = () => exhausted ? 0 : 3;
    const original = check.runtime.fetchBff;
    check.runtime.fetchBff = async (...args) => { exhausted = true; return original(...args); };
    await runGlassdoor(input({ maxReviewsPerCompany: 3 }), check.runtime);
    assert.equal(check.htmlCalls.length, 0); assert.equal(check.rows.length, 0);
});
test('review cap and history guards still apply after a gateway recovery', async () => {
    const check = managedRecoveryFixture([new GlassdoorHttpError(502, 'bff', 'gateway', 'offline')]);
    check.runtime.remainingReviews = () => check.rows.length ? 0 : 1;
    const result = await runGlassdoor(input({ maxReviewsPerCompany: 3 }), check.runtime);
    assert.equal(result.status, 'BUDGET_LIMITED'); assert.equal(result.reviewsEmitted, 1); assert.equal(check.calls.writes, 0);
});
test('only-new repeats retain delivered history without duplicate result charges after recovery', async () => {
    const check = managedRecoveryFixture([new GlassdoorHttpError(502, 'bff', 'gateway', 'offline'), new GlassdoorHttpError(502, 'bff', 'gateway', 'offline')]);
    const first = await runGlassdoor(input({}), check.runtime);
    const repeat = await runGlassdoor(input({ onlyNewReviews: true }), check.runtime);
    assert.equal(first.status, 'COMPLETE'); assert.equal(repeat.status, 'COMPLETE'); assert.equal(repeat.reviewsEmitted, 0);
    assert.equal(check.rows.length, 1); assert.equal(check.htmlCalls.length, 2); assert.equal(check.calls.writes, 2);
});
test('gateway recovery cannot mislabel another employer or an off-domain redirect', async () => {
    for (const finalUrl of [secondCompanyUrl, 'https://unrelated.example/Reviews/Example-Co-Reviews-E123.htm',
        'https://www.glassdoor.com/profile/login_input.htm', 'https://private:secret@www.glassdoor.com/Reviews/Example-Co-Reviews-E123.htm']) {
        const check = managedRecoveryFixture([new GlassdoorHttpError(502, 'bff', 'gateway', 'offline')]);
        check.runtime.fetchHtml = async (...args) => { check.htmlCalls.push(args); return { statusCode: 200, finalUrl, body: recoveryHtml() }; };
        const result = await runGlassdoor(input({}), check.runtime);
        assert.equal(result.status, 'FAILED'); assert.equal(check.rows.length, 0); assert.equal(check.calls.writes, 0);
        assert.equal(check.htmlCalls.length, 1); assert(!JSON.stringify(result).includes('private:secret'));
    }
});
