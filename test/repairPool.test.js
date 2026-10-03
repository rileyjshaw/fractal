import test from 'node:test';
import assert from 'node:assert/strict';
import { RepairPool } from '../src/deep/repairPool.js';
class Worker {
	postMessage(message) {
		this.message = message;
	}
	terminate() {
		this.terminated = true;
	}
	finish() {
		const { pixels, pixelIndices } = this.message.payload;
		for (let i = 0; i < pixelIndices.length; i++) pixels.set([pixelIndices[i], 0, 0, 1], i * 4);
		this.onmessage({
			data: { id: this.message.id, result: { pixels, pixelIndices, repairedPixels: pixelIndices.length } },
		});
	}
}
function metric() {
	const data = new Float32Array(600 * 4);
	for (let i = 3; i < data.length; i += 4) data[i] = -1;
	return { data, width: 30, height: 20 };
}
test('sparse repair batches preserve global pixel coordinates and finish atomically', async () => {
	const workers = [];
	const pool = new RepairPool(() => {
		const w = new Worker();
		workers.push(w);
		return w;
	}, 2);
	let published = false;
	const done = pool.repair(metric(), {}).then(result => {
		published = true;
		return result;
	});
	assert.equal(workers.length, 2);
	assert.deepEqual(Array.from(workers[1].message.payload.pixelIndices.slice(0, 3)), [1, 3, 5]);
	workers[1].finish();
	await Promise.resolve();
	assert.equal(published, false);
	workers[0].finish();
	const result = await done;
	assert.equal(result.repairedPixels, 600);
	for (let i = 0; i < 600; i++)
		assert.deepEqual(Array.from(result.metric.data.slice(i * 4, i * 4 + 4)), [i, 0, 0, 1]);
	pool.cancel();
});
test('non-finite metrics with positive coverage are sent for repair', async () => {
	const workers = [];
	const pool = new RepairPool(() => {
		const w = new Worker();
		workers.push(w);
		return w;
	}, 1);
	const data = new Float32Array(6 * 4).fill(1);
	data[1 * 4] = NaN;
	data[3 * 4 + 2] = Infinity;
	data[5 * 4 + 3] = -1;
	const done = pool.repair({ data, width: 3, height: 2 }, {});
	assert.deepEqual(Array.from(workers[0].message.payload.pixelIndices), [1, 3, 5]);
	workers[0].finish();
	assert.equal((await done).repairedPixels, 3);
	pool.cancel();
});
test('superseding a repair cancels every old batch and ignores late results', async () => {
	const workers = [];
	const pool = new RepairPool(() => {
		const w = new Worker();
		workers.push(w);
		return w;
	}, 2);
	const old = pool.repair(metric(), {}).catch(error => error.name);
	const next = pool.repair(metric(), {});
	assert.ok(workers[0].terminated && workers[1].terminated);
	workers[0].finish();
	workers[1].finish();
	workers[2].finish();
	workers[3].finish();
	assert.equal(await old, 'AbortError');
	assert.equal((await next).repairedPixels, 600);
	pool.cancel();
});
