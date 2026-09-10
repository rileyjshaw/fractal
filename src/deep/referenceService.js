import { DeepZoomManager } from '../deepZoom.js';
import { LatestWorker } from './workerClient.js';
const createWorker = () => new Worker(new URL('./reference.worker.js', import.meta.url), { type: 'module' });
// The inherited GMP instance handles small navigation operations only. Reference
// search, orbits, tables, and pixel repair are isolated in replaceable workers.
export class ReferenceService extends DeepZoomManager {
	constructor(options = {}) {
		super(options);
		this.jobs = new LatestWorker(options.createWorker ?? createWorker);
		this.repairs = new LatestWorker(options.createWorker ?? createWorker);
	}
	ensureReference(state) {
		const signature = this.getReferenceSignature(state);
		if (this.hasReferenceFor(state)) return Promise.resolve(this.orbitTextureData);
		if (this.hasPendingReferenceFor(state)) return this.pendingReferencePromise;
		this.pendingReferenceSignature = signature;
		const request = ++this.referenceRequestId;
		this.pendingReferencePromise = this.jobs
			.request('reference', { ...state })
			.then(result => {
				if (request !== this.referenceRequestId) return this.orbitTextureData;
				Object.assign(this, result);
				this.referenceSignature = signature;
				this.referenceOffsetSignature = null;
				this.referenceOffset = null;
				this.lastError = null;
				return this.orbitTextureData;
			})
			.catch(error => {
				if (error.name === 'AbortError') return this.orbitTextureData;
				if (request === this.referenceRequestId) this.lastError = error;
				throw error;
			})
			.finally(() => {
				if (request === this.referenceRequestId) {
					this.pendingReferencePromise = null;
					this.pendingReferenceSignature = null;
				}
			});
		return this.pendingReferencePromise;
	}
	repairFrame(metric, state) {
		return this.repairs.request('repair', { metric, state }, [metric.data.buffer]);
	}
	invalidate() {
		super.invalidate();
		this.jobs?.cancel();
		this.repairs?.cancel();
	}
	cleanup() {
		this.jobs.cancel();
		this.repairs.cancel();
		super.cleanup();
	}
}
