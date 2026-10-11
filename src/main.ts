import { Actor, log } from 'apify';
import { runGlassdoor, type CollectorRuntime } from './collector.js';
import { buildAccessTiers, fetchBff, fetchHtml, resolveCompanyName } from './access.js';
import type { ActorInput, CompanyWatchState } from './types.js';

const runtime: CollectorRuntime = {
    now: Date.now,
    buildAccessTiers, fetchBff, fetchHtml, resolveCompanyName,
    remainingReviews: () => {
        const manager = Actor.getChargingManager();
        return manager.getPricingInfo().isPayPerEvent
            ? manager.calculateMaxEventChargeCountWithinLimit('review-scraped') : Infinity;
    },
    pushReview: record => Actor.pushData(record, 'review-scraped'),
    openWatchStore: async name => {
        const store = await Actor.openKeyValueStore(name);
        return { id: store.id, getValue: key => store.getValue<CompanyWatchState>(key),
            setValue: (key, value) => store.setValue(key, value) };
    },
    setValue: (key, value, options) => Actor.setValue(key, value, options),
    setStatus: async message => { await Actor.setStatusMessage(message); },
    warn: message => log.warning(message),
};

Actor.main(async () => {
    const output = await runGlassdoor((await Actor.getInput<ActorInput>()) ?? {}, runtime);
    if (output.status === 'FAILED') await Actor.fail('Glassdoor collection failed. See OUTPUT for the verified failure stage.');
});
