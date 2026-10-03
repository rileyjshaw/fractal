import { DeepZoomManager, REFERENCE_SEARCH_RADIUS } from '../deepZoom.js';
import { LatestWorker } from './workerClient.js';
import { RepairPool } from './repairPool.js';
const createWorker = () => new Worker(new URL('./reference.worker.js', import.meta.url), { type: 'module' });
const jobCounts = () => ({ started: 0, completed: 0, cancelled: 0, failed: 0 });
function track(counts, promise) {
	counts.started++;
	return promise.then(
		result => {
			counts.completed++;
			return result;
		},
		error => {
			counts[error.name === 'AbortError' ? 'cancelled' : 'failed']++;
			throw error;
		},
	);
}
// The inherited GMP instance handles small navigation operations only. Reference
// search, orbits, tables, and pixel repair are isolated in replaceable workers.
export class ReferenceService extends DeepZoomManager {
	constructor(options = {}) {
		super(options);
		this.jobs = new LatestWorker(options.createWorker ?? createWorker);
		this.repairs = new RepairPool(options.createWorker ?? createWorker);
		this.jobCounts = { reference: jobCounts(), repair: jobCounts() };
		this.failedReferenceSignature = null;
		this.pendingReach = null;
	}
	ensureReference(state) {
		const signature = this.getReferenceSignature(state);
		if (this.hasReferenceFor(state)) return Promise.resolve(this.orbitTextureData);
		if (this.hasPendingReferenceFor(state)) return this.pendingReferencePromise;
		this.pendingReferenceSignature = signature;
		this.pendingReferenceState = state;
		const request = ++this.referenceRequestId;
		this.pendingReferencePromise = track(this.jobCounts.reference, this.jobs.request('reference', { ...state }))
			.then(result => {
				if (request !== this.referenceRequestId) return this.orbitTextureData;
				Object.assign(this, result);
				this.referenceSignature = signature;
				this.referenceOffsetSignature = null;
				this.referenceOffset = null;
				this.lastError = null;
				this.failedReferenceSignature = null;
				return this.orbitTextureData;
			})
			.catch(error => {
				if (error.name === 'AbortError') return this.orbitTextureData;
				if (request === this.referenceRequestId) {
					this.lastError = error;
					this.failedReferenceSignature = signature;
				}
				throw error;
			})
			.finally(() => {
				if (request === this.referenceRequestId) {
					this.pendingReferencePromise = null;
					this.pendingReferenceSignature = null;
					this.pendingReferenceState = null;
				}
			});
		return this.pendingReferencePromise;
	}
	// A deterministic failure would fail again; wait for the requested view to change.
	hasFailedReferenceFor(state) {
		return this.failedReferenceSignature === this.getReferenceSignature(state);
	}
	// Worst-case offset, in the view's radii along either axis, of the reference the
	// in-flight job will choose. The search can move it REFERENCE_SEARCH_RADIUS radii
	// of the requested view from that view's center.
	getPendingReferenceReach(state) {
		const pending = this.pendingReferenceState;
		if (!pending) return Infinity;
		const key = [
			this.pendingReferenceSignature,
			state.centerRealExact,
			state.centerImagExact,
			state.radiusExact,
		].join('|');
		if (this.pendingReach?.key !== key) {
			const { offsetReal, offsetImag, scale } = this.computeViewTransform(
				state.centerRealExact,
				state.centerImagExact,
				state.radiusExact,
				pending.centerRealExact,
				pending.centerImagExact,
				pending.radiusExact,
			);
			const reach = (Math.max(Math.abs(offsetReal), Math.abs(offsetImag)) + REFERENCE_SEARCH_RADIUS) / scale;
			this.pendingReach = { key, reach: Number.isFinite(reach) ? reach : Infinity };
		}
		return this.pendingReach.reach;
	}
	repairFrame(metric, state, onProgress) {
		return track(this.jobCounts.repair, this.repairs.repair(metric, state, onProgress));
	}
	invalidate() {
		super.invalidate();
		this.failedReferenceSignature = null;
		this.jobs?.cancel();
		this.repairs?.cancel();
	}
	cleanup() {
		this.jobs.cancel();
		this.repairs.cancel();
		super.cleanup();
	}
}
