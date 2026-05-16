import { GMPUtils, maxAbsWide, multiplyWide, toFloat } from './gmpUtils.js';

// One RGBA32F texel per orbit step: R = real, G = imag, B = scale exponent, A = reserved.
// The 4th channel is currently unused (zero-padded); reserve it for future per-step data
// (e.g. precomputed series-approximation polynomial flags) without changing the texel layout.
const ORBIT_TEXTURE_SIZE = 1024;
// Must match STRIPE_AVERAGE_DENSITY in perturbationShader.js / fractal.frag.
const STRIPE_AVERAGE_DENSITY = 8.0;
const ORBIT_TEXTURE_CHANNELS = 4;
const ORBIT_TEXTURE_PIXELS = ORBIT_TEXTURE_SIZE * ORBIT_TEXTURE_SIZE;
const ORBIT_TEXTURE_LENGTH = ORBIT_TEXTURE_PIXELS * ORBIT_TEXTURE_CHANNELS;
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
		// Repack the tightly interleaved (x, y, scale) orbit into one RGBA32F texel per
		// step (x, y, scale, 0). One fetch per inner-loop iteration replaces three.
		const orbitSteps = Math.floor(orbit.length / 3);
		const capacity = Math.min(orbitSteps, ORBIT_TEXTURE_PIXELS);
		const textureData = new Float32Array(ORBIT_TEXTURE_LENGTH);
		for (let i = 0; i < capacity; i++) {
			const src = i * 3;
			const dst = i * ORBIT_TEXTURE_CHANNELS;
			textureData[dst] = orbit[src];
			textureData[dst + 1] = orbit[src + 1];
			textureData[dst + 2] = orbit[src + 2];
		}
		return textureData;
	}

	computeStripeAveragePresum(orbit, polynomialLimit) {
		// Pre-sum stripeAverageAddend(z_i) over the reference orbit for i in [1, polynomialLimit];
		// added back inside the SA warm start to cancel the seam at the SA-stable boundary.
		if (polynomialLimit <= 0) return 0;
		const limit = Math.min(polynomialLimit, Math.floor(orbit.length / 3) - 1);
		let sum = 0;
		for (let i = 1; i <= limit; i++) {
			const refX = orbit[i * 3];
			const refY = orbit[i * 3 + 1];
			sum += 0.5 + 0.5 * Math.sin(STRIPE_AVERAGE_DENSITY * Math.atan2(refY, refX));
		}
		return sum;
	}

	getOrbitTextureSource() {
		if (!this.orbitTextureData) return null;
		return {
			data: this.orbitTextureData,
			width: ORBIT_TEXTURE_SIZE,
			height: ORBIT_TEXTURE_SIZE,
		};
	}

	getShaderUniforms(currentRadiusMantissa, currentRadiusExponent) {
		if (!this.referenceData) return null;
		// Series approximation is enabled only for Mandelbrot exp 2 (the polynomial
		// recurrence in gmpUtils currently bakes Mandelbrot's `+ 1` term, which is
		// incorrect for Julia). For Julia we report zero polynomial coverage so the
		// shader simply skips the warm start.
		const compatibilitySignature = this.referenceState?.compatibilitySignature;
		const isMandelbrotQuadratic = compatibilitySignature?.startsWith(`${FRACTAL_TYPE_MANDELBROT}|2|`) ?? false;
		const polynomialLimit = isMandelbrotQuadratic ? this.referenceData.polynomialLimit : 0;
		const stripeAveragePresum = isMandelbrotQuadratic ? (this.referenceData.stripeAveragePresum ?? 0) : 0;

		// Rebake the polynomial coefficients against the *current* view radius (rather
		// than the radius captured at reference-orbit compute time). The wide-form
		// polynomialWide is constant w.r.t. zoom (it only depends on the reference
		// orbit), but the linear/quadratic/cubic radius factors and the polyScale
		// normalization must be recomputed each frame so the shader's
		// `2^(pse + radiusExponent)` rescale matches the stored coefficients.
		const radiusMantissa = currentRadiusMantissa ?? this.referenceData.radiusMantissa;
		const radiusExponent = currentRadiusExponent ?? this.referenceData.radiusExponent;
		const polynomialWide = this.referenceData.polynomialWide;
		const linearScale = [radiusMantissa, 0];
		const quadraticScale = [radiusMantissa * radiusMantissa, radiusExponent];
		const cubicScale = [radiusMantissa * radiusMantissa * radiusMantissa, radiusExponent * 2];
		const linearWideX = multiplyWide(linearScale, polynomialWide[0]);
		const linearWideY = multiplyWide(linearScale, polynomialWide[1]);
		const quadraticWideX = multiplyWide(quadraticScale, polynomialWide[2]);
		const quadraticWideY = multiplyWide(quadraticScale, polynomialWide[3]);
		const cubicWideX = multiplyWide(cubicScale, polynomialWide[4]);
		const cubicWideY = multiplyWide(cubicScale, polynomialWide[5]);
		// Normalize by the largest of the three radius-scaled coefficient magnitudes
		// so all three terms fit cleanly in float32 once stored. Picking just |B'|
		// (as we previously did) overflows |C'| or |D'| at deep zoom when the cubic
		// term's accumulated exponent exceeds float32 range.
		const linearMaxAbs = maxAbsWide(linearWideX, linearWideY);
		const quadraticMaxAbs = maxAbsWide(quadraticWideX, quadraticWideY);
		const cubicMaxAbs = maxAbsWide(cubicWideX, cubicWideY);
		const linearExp = linearMaxAbs[0] !== 0 ? linearMaxAbs[1] : -Infinity;
		const quadraticExp = quadraticMaxAbs[0] !== 0 ? quadraticMaxAbs[1] : -Infinity;
		const cubicExp = cubicMaxAbs[0] !== 0 ? cubicMaxAbs[1] : -Infinity;
		const finiteExp = Math.max(
			Number.isFinite(linearExp) ? linearExp : -1024,
			Number.isFinite(quadraticExp) ? quadraticExp : -1024,
			Number.isFinite(cubicExp) ? cubicExp : -1024,
		);
		const polyScaleExponent = finiteExp;
		const polyScale = [1, -polyScaleExponent];

		return {
			u_orbitLength: this.referenceData.orbitLength,
			u_poly1: [
				toFloat(multiplyWide(polyScale, linearWideX)),
				toFloat(multiplyWide(polyScale, linearWideY)),
				toFloat(multiplyWide(polyScale, quadraticWideX)),
				toFloat(multiplyWide(polyScale, quadraticWideY)),
			],
			u_poly2: [
				toFloat(multiplyWide(polyScale, cubicWideX)),
				toFloat(multiplyWide(polyScale, cubicWideY)),
			],
			u_polynomialLimit: polynomialLimit,
			u_polyScaleExponent: polyScaleExponent,
			u_stripeAveragePresum: stripeAveragePresum,
			u_radiusMantissa: radiusMantissa,
			u_radiusExponent: radiusExponent,
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

				referenceData.stripeAveragePresum = this.computeStripeAveragePresum(
					referenceData.orbit,
					referenceData.polynomialLimit,
				);
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
