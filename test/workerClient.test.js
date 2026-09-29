import test from 'node:test';
import assert from 'node:assert/strict';
import { LatestWorker } from '../src/deep/workerClient.js';
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
}
test('superseding work terminates computation and ignores late results', async () => {
	const workers = [],
		client = new LatestWorker(() => {
			const w = new FakeWorker();
			workers.push(w);
			return w;
		});
	const old = client.request('reference', { center: 1 }).catch(error => error.name);
	const current = client.request('reference', { center: 2 });
	assert.equal(workers[0].terminated, true);
	workers[0].finish('stale');
	workers[1].finish('current');
	assert.equal(await old, 'AbortError');
	assert.equal(await current, 'current');
	client.cancel();
});
test('worker errors reject the job and the next request can recover', async () => {
	const workers = [],
		client = new LatestWorker(() => {
			const w = new FakeWorker();
			workers.push(w);
			return w;
		});
	const failed = client.request('repair', {}).catch(error => error.message);
	workers[0].onerror({ message: 'failed' });
	assert.equal(await failed, 'failed');
	const retry = client.request('repair', {});
	workers[1].finish('recovered');
	assert.equal(await retry, 'recovered');
	client.cancel();
});

test('progress keeps the job pending and cancelled jobs cannot publish patches', async () => {
	const workers = [];
	const client = new LatestWorker(() => {
		const worker = new FakeWorker();
		workers.push(worker);
		return worker;
	});
	const updates = [];
	const old = client.request('repair', {}, [], progress => updates.push(progress)).catch(error => error.name);
	workers[0].onmessage({ data: { id: workers[0].message.id, progress: 'first' } });
	assert.ok(client.pending);
	const current = client.request('repair', {}, [], progress => updates.push(progress));
	workers[0].onmessage({ data: { id: workers[0].message.id, progress: 'stale' } });
	workers[1].onmessage({ data: { id: workers[1].message.id, progress: 'current' } });
	workers[1].finish('done');
	assert.deepEqual(updates, ['first', 'current']);
	assert.equal(await old, 'AbortError');
	assert.equal(await current, 'done');
	client.cancel();
});
