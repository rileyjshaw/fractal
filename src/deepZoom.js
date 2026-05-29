import { GMPUtils } from './gmpUtils.js';
import * as profiler from './profiler.js';
import {
	BLA_MAX_LEVELS,
	BLA_TEXTURE_LENGTH,
	BLA_TEXTURE_WIDTH,
	BLA_TEXTURE_HEIGHT,
	ORBIT_TEXTURE_CHANNELS,
	ORBIT_TEXTURE_LENGTH,
	ORBIT_TEXTURE_PIXELS,
	ORBIT_TEXTURE_SIZE,
	buildHierarchicalBLATable,
	buildVisualPrefixTextureData,
} from './deepZoomTables.js';

const FRACTAL_TYPE_JULIA = 0;
const FRACTAL_TYPE_MANDELBROT = 1;
const SUPPORTED_FRACTAL_TYPES = new Set([FRACTAL_TYPE_JULIA, FRACTAL_TYPE_MANDELBROT]);
const SUPPORTED_EXPONENTS = new Set([2]); // Quadratic only for now.
// When the requested center's reference orbit escapes before reaching this fraction
// of u_iterations, sample nearby centers and pick one with a longer orbit. Short
// orbits leave the perturbation shader's loop terminating at k>=orbitLength-1, so
// every still-unescaped pixel returns interiorMetric() — the whole view goes solid.
const REFERENCE_ESCAPE_SEARCH_RATIO = 0.95;
// Max distance (in view radii) Newton's converged periodic point may sit from the
// requested center. Kept under DEEP_REFERENCE_RECENTER_OFFSET (main.js) so the chosen
// center doesn't immediately re-trigger a recenter.
const NEWTON_MAX_OFFSET_RADII = 1.5;
// Sample radii kept under DEEP_REFERENCE_RECENTER_OFFSET (main.js) so a chosen sample
// doesn't immediately re-trigger a recenter. Six rings × eight directions = 48
// candidates spanning ~36x in radius — tiny minibrots at deep zoom can be smaller
// than a few percent of the view, so the inner rings give us a chance of landing
// inside one when the requested center is just outside.
const REFERENCE_SAMPLE_OFFSETS = [
	[0.05, 0],
	[-0.05, 0],
	[0, 0.05],
	[0, -0.05],
	[0.035, 0.035],
	[-0.035, 0.035],
	[0.035, -0.035],
	[-0.035, -0.035],
	[0.15, 0],
	[-0.15, 0],
	[0, 0.15],
	[0, -0.15],
	[0.1, 0.1],
	[-0.1, 0.1],
	[0.1, -0.1],
	[-0.1, -0.1],
	[0.35, 0],
	[-0.35, 0],
	[0, 0.35],
	[0, -0.35],
	[0.25, 0.25],
	[-0.25, 0.25],
	[0.25, -0.25],
	[-0.25, -0.25],
	[0.7, 0],
	[-0.7, 0],
	[0, 0.7],
	[0, -0.7],
	[0.5, 0.5],
	[-0.5, 0.5],
	[0.5, -0.5],
	[-0.5, -0.5],
	[1.2, 0],
	[-1.2, 0],
	[0, 1.2],
	[0, -1.2],
	[0.85, 0.85],
	[-0.85, 0.85],
	[0.85, -0.85],
	[-0.85, -0.85],
	[1.8, 0],
	[-1.8, 0],
	[0, 1.8],
	[0, -1.8],
	[1.27, 1.27],
	[-1.27, 1.27],
	[1.27, -1.27],
	[-1.27, -1.27],
];

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
		this.blaTableData = null;
		this.visualPrefixTextureData = null;
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
		this.blaTableData = null;
		this.visualPrefixTextureData = null;
		this.pendingReferenceSignature = null;
		this.pendingReferencePromise = null;
	}

	getReferenceSignature(state) {
		const referenceIterations = state.deepIterations ?? state.iterations;
		const centerReal = state.centerRealExact ?? state.centerReal;
		const centerImag = state.centerImagExact ?? state.centerImag;
		// The orbit recurrence only depends on center/formula, but the reference
		// center search uses the view radius to decide which nearby center is valid.
		// Keep radius in the identity so zoom-driven recenter requests cannot be
		// short-circuited by an older shifted reference for the same view center.
		const radius = state.radiusExact ?? state.radius;
		const constantReal = state.fractalType === FRACTAL_TYPE_JULIA ? Number(state.cReal).toPrecision(12) : '';
		const constantImag = state.fractalType === FRACTAL_TYPE_JULIA ? Number(state.cImaginary).toPrecision(12) : '';
		return [
			centerReal,
			centerImag,
			radius,
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
		// Formula compatibility is weaker than renderability: a reference for the same
		// Julia/Mandelbrot parameters can still be too short for the current zoom. Keep
		// that distinction explicit so preparation can reuse compatible references for
		// offset checks while the render loop requires hasRenderableReferenceFor().
		return (
			this.referenceState !== null &&
			this.orbitTextureData !== null &&
			this.referenceState.compatibilitySignature === this.getReferenceCompatibilitySignature(state)
		);
	}

	hasRenderableReferenceFor(state) {
		return this.hasCompatibleReferenceFor(state) && !this.referenceIterationsBelow(state);
	}

	referenceIterationsBelow(state) {
		const targetIterations = state.deepIterations ?? state.iterations;
		return this.referenceState !== null && this.referenceState.referenceIterations < targetIterations;
	}

	hasPendingReferenceFor(state) {
		return this.pendingReferenceSignature === this.getReferenceSignature(state);
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

	getOrbitTextureSource() {
		if (!this.orbitTextureData) return null;
		return {
			data: this.orbitTextureData,
			width: ORBIT_TEXTURE_SIZE,
			height: ORBIT_TEXTURE_SIZE,
		};
	}

	// Bivariate Linear Approximation (BLA): a hierarchy of precomputed linear
	// coefficients. Level 0 skips 32 steps; each higher level doubles that span.
	// The shader tries larger levels first and falls back to scalar perturbation
	// when the stored validity radius rejects a pixel.
	buildBLATable(orbit) {
		return buildHierarchicalBLATable(orbit);
	}

	getBLATextureSource() {
		if (!this.blaTableData) return null;
		return {
			data: this.blaTableData,
			width: BLA_TEXTURE_WIDTH,
			height: BLA_TEXTURE_HEIGHT,
		};
	}

	getVisualPrefixTextureSource() {
		if (!this.visualPrefixTextureData) return null;
		return {
			data: this.visualPrefixTextureData,
			width: ORBIT_TEXTURE_SIZE,
			height: ORBIT_TEXTURE_SIZE,
		};
	}

	getReferenceOrbitLength() {
		return this.referenceData?.orbitLength ?? 0;
	}

	async findGoodReferenceCenter(
		centerReal,
		centerImag,
		radius,
		requiredIterations,
		targetIterations,
		options,
		requestId,
	) {
		// Strategy A — Newton-on-period.
		// Deterministically converge to a periodic point near the requested center.
		// Periodic points have provably non-escaping orbits, so orbitLength always
		// reaches targetIterations and no pixel falls through the shader's iteration
		// cap. This is the only way to fix the "small pan → minibrot disappears"
		// class of bug — grid sampling is inherently lucky/unlucky depending on
		// whether a sample lands inside a small minibrot. Works for both Mandelbrot
		// (solve f^p_c(0) = 0 in c) and Julia (solve f^p_c(z) = z in z, with c fixed
		// at the user's parameter).
		const newtonCenter = await profiler.measureAsync('ref:newton.search', () =>
			this.gmp.findPeriodicReferenceCenter(
				centerReal,
				centerImag,
				// The Newton-found center must stay within the recenter envelope or it
				// would immediately re-trigger a recompute. Bound at NEWTON_MAX_OFFSET_RADII
				// view radii — well under DEEP_REFERENCE_RECENTER_OFFSET so the chosen
				// center won't immediately re-trigger a recenter.
				this.gmp.scaleValue(radius, NEWTON_MAX_OFFSET_RADII),
				{
					fractalType: options.fractalType,
					cReal: options.cReal,
					cImaginary: options.cImaginary,
					// Bail mid-Newton if a newer recompute has been requested (user kept
					// panning). Avoids burning ~1s of MPFR work on a result that will be discarded.
					isAborted: () => requestId !== this.referenceRequestId,
				},
			),
		);
		if (newtonCenter && requestId === this.referenceRequestId) {
			profiler.note('ref:newton.period', newtonCenter.period);
			const finalResult = profiler.measure('ref:newton.computeFinalOrbit', () =>
				this.gmp.computeReferenceData(
					newtonCenter.centerReal,
					newtonCenter.centerImag,
					targetIterations,
					options,
				),
			);
			profiler.note('ref:orbitLength', finalResult.orbitLength);
			return {
				...finalResult,
				centerRealExact: newtonCenter.centerReal,
				centerImagExact: newtonCenter.centerImag,
			};
		}

		// Strategy B — grid sampling fallback.
		// Two-phase: cheap sample at requiredIterations (= u_iterations the shader will
		// actually run), then recompute selected center at full targetIterations. Used
		// when Newton can't find a periodic point (view far from any periodic structure,
		// period > maxPeriod, Newton diverged outside the bound, etc.).
		const acceptableOrbitLength = Math.ceil(requiredIterations * REFERENCE_ESCAPE_SEARCH_RATIO);

		let bestCenterReal = centerReal;
		let bestCenterImag = centerImag;
		let bestOrbitLength = -1;

		const trySample = (sReal, sImag) => {
			const result = profiler.measure('ref:sample.computeOrbit', () =>
				this.gmp.computeReferenceData(sReal, sImag, requiredIterations, options),
			);
			if (result.orbitLength > bestOrbitLength) {
				bestCenterReal = sReal;
				bestCenterImag = sImag;
				bestOrbitLength = result.orbitLength;
			}
			return bestOrbitLength >= acceptableOrbitLength;
		};

		if (!trySample(centerReal, centerImag) && requestId === this.referenceRequestId) {
			for (const [offsetReal, offsetImag] of REFERENCE_SAMPLE_OFFSETS) {
				// Yield so the render loop and input handlers stay responsive; each
				// computeReferenceData at deep zoom can take tens of ms.
				await new Promise(resolve => setTimeout(resolve, 0));
				if (requestId !== this.referenceRequestId) break;

				const offset = this.gmp.translateCenter(centerReal, centerImag, radius, offsetReal, offsetImag);
				if (trySample(offset.centerReal, offset.centerImag)) break;
			}
		}

		profiler.note('ref:sample.bestOrbitLength', bestOrbitLength);
		const finalResult = profiler.measure('ref:sample.computeFinalOrbit', () =>
			this.gmp.computeReferenceData(bestCenterReal, bestCenterImag, targetIterations, options),
		);
		profiler.note('ref:orbitLength', finalResult.orbitLength);
		return {
			...finalResult,
			centerRealExact: bestCenterReal,
			centerImagExact: bestCenterImag,
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
				this.findGoodReferenceCenter(
					state.centerRealExact ?? state.centerReal,
					state.centerImagExact ?? state.centerImag,
					state.radiusExact ?? state.radius,
					state.requiredIterations ?? state.deepIterations ?? state.iterations,
					state.deepIterations ?? state.iterations,
					{
						fractalType: state.fractalType,
						cReal: state.cReal,
						cImaginary: state.cImaginary,
					},
					requestId,
				),
			)
			.then(referenceData => {
				if (requestId !== this.referenceRequestId) {
					return this.orbitTextureData;
				}

				this.referenceData = referenceData;
				// Track the center that was actually iterated (findGoodReferenceCenter may
				// have shifted it). getReferenceOffsetFor reads this to build u_referenceOffset.
				this.referenceState = {
					centerRealExact: referenceData.centerRealExact,
					centerImagExact: referenceData.centerImagExact,
					radiusExact: state.radiusExact ?? state.radius,
					referenceIterations: state.deepIterations ?? state.iterations,
					compatibilitySignature: this.getReferenceCompatibilitySignature(state),
				};
				this.referenceSignature = signature;
				this.referenceOffsetSignature = null;
				this.referenceOffset = null;
				this.orbitTextureData = profiler.measure('ref:buildOrbitTexture', () =>
					this.buildOrbitTextureData(referenceData.orbit),
				);
				this.visualPrefixTextureData = profiler.measure('ref:buildVisualPrefixTexture', () =>
					buildVisualPrefixTextureData(referenceData.orbit),
				);
				this.blaTableData = profiler.measure('ref:buildBLAHierarchy', () =>
					this.buildBLATable(referenceData.orbit),
				);
				profiler.note('ref:blaLevels', BLA_MAX_LEVELS);
				profiler.note('ref:blaTextureMB', (BLA_TEXTURE_LENGTH * 4) / (1024 * 1024));
				profiler.note('ref:visualPrefixTextureMB', (ORBIT_TEXTURE_LENGTH * 4) / (1024 * 1024));
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
				this.blaTableData = null;
				this.visualPrefixTextureData = null;
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
