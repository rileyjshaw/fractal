import { GMPUtils } from './gmpUtils.js';

const ORBIT_TEXTURE_SIZE = 1024;
const ORBIT_TEXTURE_LENGTH = ORBIT_TEXTURE_SIZE * ORBIT_TEXTURE_SIZE;
const FRACTAL_TYPE_JULIA = 0;
const FRACTAL_TYPE_MANDELBROT = 1;
const SUPPORTED_FRACTAL_TYPES = new Set([FRACTAL_TYPE_JULIA, FRACTAL_TYPE_MANDELBROT]);
const SUPPORTED_EXPONENTS = new Set([2]); // Quadratic only for now.

export class DeepZoomManager {
	constructor({ threshold = 16 } = {}) {
		this.gmp = new GMPUtils();
		this.deepZoomThreshold = threshold;
		this.isInitialized = false;
		this.isInitializing = false;
		this.initializePromise = null;
		this.referenceData = null;
		this.referenceState = null;
		this.referenceSignature = null;
		this.referenceOffsetSignature = null;
		this.referenceOffset = null;
		this.orbitTextureData = null;
		this.pendingReferenceSignature = null;
		this.pendingReferencePromise = null;
		this.referenceRequestId = 0;
		this.lastError = null;
	}

	async initialize() {
		if (this.isInitialized) return;
		if (this.initializePromise) return this.initializePromise;

		this.isInitializing = true;
		this.initializePromise = this.gmp
			.init()
			.then(() => {
				this.isInitialized = true;
			})
			.finally(() => {
				this.isInitializing = false;
				this.initializePromise = null;
			});

		return this.initializePromise;
	}

	shouldUseDeepZoom(zoomLevel) {
		return zoomLevel > this.deepZoomThreshold;
	}

	supportsState(state) {
		if (!SUPPORTED_FRACTAL_TYPES.has(state.fractalType)) {
			return {
				supported: false,
				reason: 'Deep zoom currently supports Julia and Mandelbrot only; folded fractals need their own perturbation path',
			};
		}
		if (!SUPPORTED_EXPONENTS.has(state.exponent)) {
			return { supported: false, reason: 'Deep zoom currently supports exponent 2 only' };
		}
		return { supported: true, reason: null };
	}

	invalidate() {
		this.referenceRequestId += 1;
		this.referenceData = null;
		this.referenceState = null;
		this.referenceSignature = null;
		this.referenceOffsetSignature = null;
		this.referenceOffset = null;
		this.orbitTextureData = null;
		this.pendingReferenceSignature = null;
		this.pendingReferencePromise = null;
	}

	getReferenceSignature(state) {
		const referenceIterations = state.deepIterations ?? state.iterations;
		const centerReal = state.centerRealExact ?? state.centerReal;
		const centerImag = state.centerImagExact ?? state.centerImag;
		const constantReal = state.fractalType === FRACTAL_TYPE_JULIA ? Number(state.cReal).toPrecision(12) : '';
		const constantImag = state.fractalType === FRACTAL_TYPE_JULIA ? Number(state.cImaginary).toPrecision(12) : '';
		return [
			centerReal,
			centerImag,
			referenceIterations,
			state.fractalType,
			state.exponent,
			constantReal,
			constantImag,
		].join('|');
	}

	getReferenceCompatibilitySignature(state) {
		const constantReal = state.fractalType === FRACTAL_TYPE_JULIA ? Number(state.cReal).toPrecision(12) : '';
		const constantImag = state.fractalType === FRACTAL_TYPE_JULIA ? Number(state.cImaginary).toPrecision(12) : '';
		return [state.fractalType, state.exponent, constantReal, constantImag].join('|');
	}

	hasReferenceFor(state) {
		return this.referenceSignature === this.getReferenceSignature(state) && this.orbitTextureData !== null;
	}

	hasCompatibleReferenceFor(state) {
		// Iteration-count adequacy is intentionally NOT checked here. The perturbation
		// shader already guards its inner loop with `k >= orbitLength - 1` and breaks
		// gracefully, so rendering with an under-iterated reference produces a tiny
		// cosmetic glitch (a few interior pixels rendered as in-set for a frame or two
		// while a longer orbit is being recomputed) rather than a fallback to the
		// standard renderer. The "needs more iterations" trigger lives in
		// shouldRecenterDeepReference so the recompute still gets scheduled.
		return (
			this.referenceState !== null &&
			this.orbitTextureData !== null &&
			this.referenceState.compatibilitySignature === this.getReferenceCompatibilitySignature(state)
		);
	}

	referenceIterationsBelow(state) {
		const targetIterations = state.deepIterations ?? state.iterations;
		return this.referenceState !== null && this.referenceState.referenceIterations < targetIterations;
	}

	getReferenceOffsetFor(state) {
		if (!this.referenceState || !this.hasCompatibleReferenceFor(state)) return null;

		const targetRadius = state.radiusExact ?? state.radius;
		const signature = [
			this.referenceSignature,
			state.centerRealExact ?? state.centerReal,
			state.centerImagExact ?? state.centerImag,
			targetRadius,
		].join('|');
		if (this.referenceOffsetSignature === signature) {
			return this.referenceOffset;
		}

		this.referenceOffset = this.computeViewTransform(
			state.centerRealExact ?? state.centerReal,
			state.centerImagExact ?? state.centerImag,
			targetRadius,
			this.referenceState.centerRealExact,
			this.referenceState.centerImagExact,
			targetRadius,
		);
		this.referenceOffsetSignature = signature;
		return this.referenceOffset;
	}

	buildOrbitTextureData(orbit) {
		const textureData = new Float32Array(ORBIT_TEXTURE_LENGTH);
		textureData.fill(-1);
		textureData.set(orbit.subarray(0, Math.min(orbit.length, textureData.length)));
		return textureData;
	}

	getOrbitTextureSource() {
		if (!this.orbitTextureData) return null;
		return {
			data: this.orbitTextureData,
			width: ORBIT_TEXTURE_SIZE,
			height: ORBIT_TEXTURE_SIZE,
		};
	}

	getShaderUniforms() {
		if (!this.referenceData) return null;
		return {
			u_orbitLength: this.referenceData.orbitLength,
			u_poly1: Array.from(this.referenceData.poly1),
			u_poly2: Array.from(this.referenceData.poly2),
			u_radiusMantissa: this.referenceData.radiusMantissa,
			u_radiusExponent: this.referenceData.radiusExponent,
		};
	}

	async ensureReference(state) {
		if (!this.isInitialized) {
			throw new Error('Deep zoom manager not initialized');
		}

		const signature = this.getReferenceSignature(state);
		if (this.referenceSignature === signature && this.orbitTextureData) {
			return this.orbitTextureData;
		}
		if (this.pendingReferencePromise && this.pendingReferenceSignature === signature) {
			return this.pendingReferencePromise;
		}

		const requestId = ++this.referenceRequestId;
		this.pendingReferenceSignature = signature;
		this.pendingReferencePromise = Promise.resolve()
			.then(() =>
				this.gmp.computeReferenceData(
					state.centerRealExact ?? state.centerReal,
					state.centerImagExact ?? state.centerImag,
					state.radiusExact ?? state.radius,
					state.deepIterations ?? state.iterations,
					{
						fractalType: state.fractalType,
						cReal: state.cReal,
						cImaginary: state.cImaginary,
					},
				),
			)
			.then(referenceData => {
				if (requestId !== this.referenceRequestId) {
					return this.orbitTextureData;
				}

				this.referenceData = referenceData;
				this.referenceState = {
					centerRealExact: state.centerRealExact ?? state.centerReal,
					centerImagExact: state.centerImagExact ?? state.centerImag,
					radiusExact: state.radiusExact ?? state.radius,
					referenceIterations: state.deepIterations ?? state.iterations,
					compatibilitySignature: this.getReferenceCompatibilitySignature(state),
				};
				this.referenceSignature = signature;
				this.referenceOffsetSignature = null;
				this.referenceOffset = null;
				this.orbitTextureData = this.buildOrbitTextureData(referenceData.orbit);
				this.lastError = null;
				return this.orbitTextureData;
			})
			.catch(error => {
				if (requestId !== this.referenceRequestId) {
					return this.orbitTextureData;
				}

				this.referenceData = null;
				this.referenceState = null;
				this.referenceSignature = null;
				this.referenceOffsetSignature = null;
				this.referenceOffset = null;
				this.orbitTextureData = null;
				this.lastError = error;
				throw error;
			})
			.finally(() => {
				if (requestId === this.referenceRequestId && this.pendingReferenceSignature === signature) {
					this.pendingReferenceSignature = null;
					this.pendingReferencePromise = null;
				}
			});

		return this.pendingReferencePromise;
	}

	translateCenter(centerReal, centerImag, radius, deltaReal, deltaImag) {
		if (!this.isInitialized) {
			throw new Error('Deep zoom manager not initialized');
		}

		return this.gmp.translateCenter(centerReal, centerImag, radius, deltaReal, deltaImag);
	}

	decomposeValue(value) {
		if (!this.isInitialized) {
			throw new Error('Deep zoom manager not initialized');
		}

		return this.gmp.decomposeValue(value);
	}

	scaleValue(value, factor) {
		if (!this.isInitialized) {
			throw new Error('Deep zoom manager not initialized');
		}

		return this.gmp.scaleValue(value, factor);
	}

	computeViewTransform(
		currentCenterReal,
		currentCenterImag,
		currentRadius,
		sourceCenterReal,
		sourceCenterImag,
		sourceRadius,
	) {
		if (!this.isInitialized) {
			throw new Error('Deep zoom manager not initialized');
		}

		return this.gmp.computeViewTransform(
			currentCenterReal,
			currentCenterImag,
			currentRadius,
			sourceCenterReal,
			sourceCenterImag,
			sourceRadius,
		);
	}

	cleanup() {
		this.gmp.cleanup();
		this.invalidate();
		this.isInitialized = false;
		this.isInitializing = false;
		this.initializePromise = null;
	}
}
