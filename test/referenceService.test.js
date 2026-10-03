import test from 'node:test';
import assert from 'node:assert/strict';
import { ReferenceService } from '../src/deep/referenceService.js';
import { REFERENCE_SEARCH_RADIUS } from '../src/deepZoom.js';
class FakeWorker {
	postMessage(message) {
		this.message = message;
	}
	terminate() {
		this.terminated = true;
	}
	finish(result) {
		this.onmessage({ data: { id: this.message.id, result } });
	}
	fail(error) {
		this.onmessage({ data: { id: this.message.id, error } });
	}
}
function service() {
	const workers = [];
	const instance = new ReferenceService({
		createWorker: () => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		},
	});
	return { instance, workers };
}
const view = {
	centerRealExact: '-0.5',
	centerImagExact: '0.25',
	radiusExact: '1e-20',
	deepIterations: 12322,
	fractalType: 0,
	exponent: 2,
	cReal: -0.71,
	cImaginary: -0.43,
};
const reference = { referenceState: { referenceIterations: 12322 }, orbitTextureData: new Float32Array(4) };
test('job counters distinguish completed, cancelled and failed references', async () => {
	const { instance, workers } = service();
	const cancelled = instance.ensureReference(view);
	const completed = instance.ensureReference({ ...view, radiusExact: '5e-21' });
	workers[1].finish(reference);
	await Promise.all([cancelled, completed]);
	const failed = instance.ensureReference({ ...view, radiusExact: '2e-21' }).catch(error => error.message);
	workers[1].fail('No iterations completed in orbit computation');
	assert.equal(await failed, 'No iterations completed in orbit computation');
	assert.deepEqual(instance.jobCounts.reference, { started: 3, completed: 1, cancelled: 1, failed: 1 });
	instance.cleanup();
});
test('a failed reference is not retried until the requested view changes', async () => {
	const { instance, workers } = service();
	const failed = instance.ensureReference(view).catch(() => {});
	workers[0].fail('Invalid MPFR value');
	await failed;
	assert.equal(instance.hasFailedReferenceFor(view), true);
	assert.equal(instance.hasFailedReferenceFor({ ...view, radiusExact: '5e-21' }), false);
	const retry = instance.ensureReference({ ...view, radiusExact: '5e-21' });
	workers[0].finish(reference);
	await retry;
	assert.equal(instance.hasFailedReferenceFor(view), false);
	instance.invalidate();
	assert.equal(instance.failedReferenceSignature, null);
	instance.cleanup();
});
test('repair jobs are counted, including superseded ones', async () => {
	const { instance, workers } = service();
	instance.repairs.lanes.length = 1;
	const metric = () => ({ data: new Float32Array([-1, 0, 0, -1]), width: 1, height: 1 });
	const old = instance.repairFrame(metric(), view).catch(error => error.name);
	const next = instance.repairFrame(metric(), view);
	const lane = workers.at(-1);
	lane.finish({ pixels: new Float32Array([1, 0, 0, 1]), pixelIndices: new Uint32Array([0]), repairedPixels: 1 });
	assert.equal(await old, 'AbortError');
	assert.equal((await next).repairedPixels, 1);
	assert.deepEqual(instance.jobCounts.repair, { started: 2, completed: 1, cancelled: 1, failed: 0 });
	instance.cleanup();
});
test('pending reference reach bounds where the in-flight search can land for the current view', async () => {
	const { instance } = service();
	await instance.initialize();
	try {
		assert.equal(instance.getPendingReferenceReach(view), Infinity);
		instance.ensureReference(view).catch(() => {});
		assert.equal(instance.getPendingReferenceReach(view), REFERENCE_SEARCH_RADIUS);
		// Zoomed in 2x and panned one pending radius: offsets double in current radii.
		const moved = { ...view, radiusExact: '5e-21', centerRealExact: '-0.49999999999999999999' };
		assert.ok(Math.abs(instance.getPendingReferenceReach(moved) - 2 * (1 + REFERENCE_SEARCH_RADIUS)) < 1e-9);
	} finally {
		instance.cleanup();
	}
});
