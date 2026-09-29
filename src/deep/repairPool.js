import { LatestWorker } from './workerClient.js';

// Sparse batches avoid copying a full-resolution image into every worker.
// Publication stays atomic: callers receive the frame only after all batches finish.
export class RepairPool {
	constructor(createWorker, size = Math.min(4, globalThis.navigator?.hardwareConcurrency ?? 2)) {
		this.lanes = Array.from({ length: Math.max(1, size) }, () => new LatestWorker(createWorker));
		this.generation = 0;
		this.pending = false;
	}
	async repair(metric, state, onProgress) {
		if (this.pending) this.cancel();
		const generation = ++this.generation;
		this.pending = true;
		const indices = [];
		for (let i = 0; i < metric.data.length; i += 4) {
			if (metric.data[i + 3] < 0 || !metric.data.subarray(i, i + 4).every(Number.isFinite)) indices.push(i / 4);
		}
		const count = Math.min(this.lanes.length, Math.ceil(indices.length / 256));
		const completed = Array(count).fill(0);
		try {
			await Promise.all(
				this.lanes.slice(0, count).map(async (lane, laneIndex) => {
					const pixelIndices = Uint32Array.from(indices.filter((_, i) => i % count === laneIndex));
					const pixels = new Float32Array(pixelIndices.length * 4);
					for (let i = 0; i < pixelIndices.length; i++)
						pixels.set(metric.data.subarray(pixelIndices[i] * 4, pixelIndices[i] * 4 + 4), i * 4);
					const update = repaired => {
						if (generation !== this.generation) return;
						completed[laneIndex] = repaired;
						onProgress?.({ repairedPixels: completed.reduce((a, b) => a + b, 0) });
					};
					const result = await lane.request(
						'repairBatch',
						{
							pixels,
							pixelIndices,
							width: metric.width,
							height: metric.height,
							state,
						},
						[pixels.buffer, pixelIndices.buffer],
						progress => update(progress.repairedPixels),
					);
					if (generation !== this.generation) throw new DOMException('Superseded repair', 'AbortError');
					for (let i = 0; i < result.pixelIndices.length; i++)
						metric.data.set(result.pixels.subarray(i * 4, i * 4 + 4), result.pixelIndices[i] * 4);
					update(result.repairedPixels);
				}),
			);
			return { metric, repairedPixels: indices.length };
		} catch (error) {
			if (generation === this.generation) this.cancel();
			throw error;
		} finally {
			if (generation === this.generation) this.pending = false;
		}
	}
	cancel() {
		this.generation++;
		this.pending = false;
		for (const lane of this.lanes) lane.cancel();
	}
}
