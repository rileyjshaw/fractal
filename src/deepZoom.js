import { GMPUtils, maxAbsWide, multiplyWide, toFloat } from './gmpUtils.js';
import * as profiler from './profiler.js';

// One RGBA32F texel per orbit step: R = real, G = imag, B = scale exponent, A = unused.
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
	[0.05, 0], [-0.05, 0], [0, 0.05], [0, -0.05],
	[0.035, 0.035], [-0.035, 0.035], [0.035, -0.035], [-0.035, -0.035],
	[0.15, 0], [-0.15, 0], [0, 0.15], [0, -0.15],
	[0.1, 0.1], [-0.1, 0.1], [0.1, -0.1], [-0.1, -0.1],
	[0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35],
	[0.25, 0.25], [-0.25, 0.25], [0.25, -0.25], [-0.25, -0.25],
	[0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7],
	[0.5, 0.5], [-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5],
	[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2],
	[0.85, 0.85], [-0.85, 0.85], [0.85, -0.85], [-0.85, -0.85],
	[1.8, 0], [-1.8, 0], [0, 1.8], [0, -1.8],
	[1.27, 1.27], [-1.27, 1.27], [1.27, -1.27], [-1.27, -1.27],
];

// Bivariate Linear Approximation (BLA): precomputed per-iteration-range linear
// coefficients (A, B) such that dz_{n+CHUNK} ≈ A * dz_n + B * dc when |dz_n| is
// small enough that the dropped dz² term is negligible. The perturbation shader
// can then skip BLA_CHUNK_SIZE iters in one texture fetch instead of running
// the per-iter recurrence. At deep zoom this is a 10-100× speedup since each
// per-iter step costs ~10 GLSL ops + 1 texture fetch.
//
// Single-level BLA (one fixed chunk size). Hierarchical (multiple chunk sizes
// with descending fallback) gives bigger speedups but adds significant
// complexity. Start with single-level; hierarchical is a follow-up.
const BLA_CHUNK_SIZE = 32;
// BLA validity epsilon. With the proper per-step validity formula (R_n
// accounting for max dz growth over the chunk), 1e-3 is enough — most of the
// safety margin comes from the formula itself, not the epsilon.
const BLA_VALIDITY_EPSILON = 1e-3;
// 8 floats per orbit position, packed into 2 RGBA32F texels:
//   texel 0: [A_mantissa_real, A_mantissa_imag, A_scaleExp, validityRsqLog2]
//   texel 1: [B_mantissa_real, B_mantissa_imag, B_scaleExp, _unused_]
const BLA_FLOATS_PER_ENTRY = 8;
const BLA_TEXELS_PER_ENTRY = 2;
// BLA texture dimensions. Width matches ORBIT_TEXTURE_SIZE so the shader's
// row/col math from k is straightforward (entry k → texels at column k*2 in
// row k/(width/2)). Height covers DEEP_MAX_ITERATIONS = 65536 entries with
// some headroom.
const BLA_TEXTURE_WIDTH = ORBIT_TEXTURE_SIZE;
const BLA_TEXTURE_HEIGHT = 256;
const BLA_TEXTURE_LENGTH = BLA_TEXTURE_WIDTH * BLA_TEXTURE_HEIGHT * 4;

// Re-normalize a complex number kept as (mantissa_real, mantissa_imag, scaleExp).
// Keeps the mantissa magnitude near 1 so subsequent multiplications don't
// overflow or underflow float32 even when the running scaleExp gets huge.
function normalizeWide(mantR, mantI, exp) {
	const magSq = mantR * mantR + mantI * mantI;
	if (magSq === 0) return { mantR: 0, mantI: 0, exp };
	const halfLog = 0.5 * Math.log2(magSq);
	if (halfLog > -10 && halfLog < 10) return { mantR, mantI, exp };
	const shift = Math.round(halfLog);
	const factor = Math.pow(2, -shift);
	return { mantR: mantR * factor, mantI: mantI * factor, exp: exp + shift };
}

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

	// Build the BLA table from a reference orbit. For each starting position i,
	// compose:
	//   A = ∏_{n=i}^{i+CHUNK-1} (2 * Z_n)
	//   B = sum over n of (∏ of remaining 2Z terms after step n)
	// so that dz_{i+CHUNK} ≈ A * dz_i + B * dc.
	//
	// The composition is done in scale-exponent form because A grows exponentially
	// at deep zoom (each factor 2*Z can be O(1), but a chunk of 32 multiplications
	// produces something well outside float32 range).
	//
	// Returns a Float32Array of orbitLength * BLA_FLOATS_PER_ENTRY values, plus
	// a chunkSize value for the shader to know how many iters each chunk skips.
	// Entries past (orbitLength - chunkSize) have R²=0 (invalid) — the shader
	// falls back to per-iter perturbation there.
	buildBLATable(orbit) {
		const orbitLength = Math.floor(orbit.length / 3);
		// Always allocate the full texture size so shader-side bounds checks line
		// up; entries past orbitLength stay zero and are guarded by k bounds.
		const data = new Float32Array(BLA_TEXTURE_LENGTH);
		const log2Epsilon = Math.log2(BLA_VALIDITY_EPSILON);

		for (let i = 0; i < orbitLength; i++) {
			const dst = i * BLA_FLOATS_PER_ENTRY;
			if (i + BLA_CHUNK_SIZE > orbitLength) {
				// Not enough orbit left for a full chunk; mark invalid by setting the
				// validity threshold to a large negative log (R² = 0, no |dz|² < R²).
				data[dst + 3] = -1.0e30;
				continue;
			}

			// Compose A, B over [i, i+CHUNK_SIZE).
			// Start: A_0 = 1, B_0 = 0. At step n we have A_n = ∏_{m<n} (2 Z_m) and
			// B_n = sum over m<n of ∏_{l in (m, n)} (2 Z_l).
			let a = { mantR: 1, mantI: 0, exp: 0 };
			let b = { mantR: 0, mantI: 0, exp: 0 };
			// "Max growth" validity radius²: at each step n the linear approximation is
			// valid iff |dz_n| < 2|Z_n|·ε. dz_n = A_n·dz_initial + B_n·dc, so the worst
			// case is |dz_n| ≤ (|A_n| + |B_n|)·max(|dz_initial|, |dc|). Solving for
			// max(|dz_init|, |dc|):
			//   max < 2|Z_n|·ε / (|A_n| + |B_n|)
			// → R_n² = 4|Z_n|²·ε² / (|A_n| + |B_n|)²
			// Take min over n in the chunk so the worst (usually last, with |A| largest)
			// step bounds R². In log2 space with the bound log2(|A|+|B|) ≤ max(log2|A|,
			// log2|B|) + 1 this simplifies to:
			//   log2(R_n²) ≥ log2|Z_n|² + 2 log2(ε) − max(log2|A_n|², log2|B_n|²)
			let minRSqLog2 = Infinity;

			for (let n = 0; n < BLA_CHUNK_SIZE; n++) {
				const src = (i + n) * 3;
				const zMantR = orbit[src];
				const zMantI = orbit[src + 1];
				const zExp = orbit[src + 2];

				const zMagSq = zMantR * zMantR + zMantI * zMantI;
				if (zMagSq === 0) {
					// |Z_n|=0 → constraint is |dz_n| < 0, no valid R.
					minRSqLog2 = -Infinity;
				} else {
					const zLogMagSq = Math.log2(zMagSq) + 2 * zExp;
					// |A_n|² and |B_n|² at the START of this step (before applying 2Z_n).
					const aMagSq = a.mantR * a.mantR + a.mantI * a.mantI;
					const bMagSq = b.mantR * b.mantR + b.mantI * b.mantI;
					const aLogMagSq = aMagSq > 0 ? Math.log2(aMagSq) + 2 * a.exp : -Infinity;
					const bLogMagSq = bMagSq > 0 ? Math.log2(bMagSq) + 2 * b.exp : -Infinity;
					// Conservative log2((|A|+|B|)²) ≈ max(log2|A|², log2|B|²) + 2
					// (= log2((max + max)²) — bounds (|A|+|B|)² ≤ 4·max(|A|,|B|)²).
					let abSumSqLog2;
					if (aLogMagSq === -Infinity && bLogMagSq === -Infinity) {
						abSumSqLog2 = -Infinity;
					} else {
						abSumSqLog2 = Math.max(aLogMagSq, bLogMagSq) + 2;
					}
					const rSqLog2 =
						abSumSqLog2 === -Infinity
							? Infinity
							: zLogMagSq + 2 * log2Epsilon - abSumSqLog2;
					if (rSqLog2 < minRSqLog2) minRSqLog2 = rSqLog2;
				}

				// Update A, B for next step's partial.
				const twoZ = { mantR: 2 * zMantR, mantI: 2 * zMantI, exp: zExp };
				a = normalizeWide(
					twoZ.mantR * a.mantR - twoZ.mantI * a.mantI,
					twoZ.mantR * a.mantI + twoZ.mantI * a.mantR,
					twoZ.exp + a.exp,
				);
				const bMulZ = normalizeWide(
					twoZ.mantR * b.mantR - twoZ.mantI * b.mantI,
					twoZ.mantR * b.mantI + twoZ.mantI * b.mantR,
					twoZ.exp + b.exp,
				);
				if (bMulZ.mantR === 0 && bMulZ.mantI === 0) {
					b = { mantR: 1, mantI: 0, exp: 0 };
				} else {
					const commonExp = Math.max(bMulZ.exp, 0);
					const bMulZShift = Math.pow(2, bMulZ.exp - commonExp);
					const oneShift = Math.pow(2, 0 - commonExp);
					b = normalizeWide(
						bMulZ.mantR * bMulZShift + oneShift,
						bMulZ.mantI * bMulZShift,
						commonExp,
					);
				}
			}

			const validityRSqLog2 =
				minRSqLog2 === Infinity || minRSqLog2 === -Infinity ? -1.0e30 : minRSqLog2;

			data[dst] = a.mantR;
			data[dst + 1] = a.mantI;
			data[dst + 2] = a.exp;
			data[dst + 3] = validityRSqLog2;
			data[dst + 4] = b.mantR;
			data[dst + 5] = b.mantI;
			data[dst + 6] = b.exp;
			data[dst + 7] = 0;
		}

		return data;
	}

	getBLATextureSource() {
		if (!this.blaTableData) return null;
		return {
			data: this.blaTableData,
			width: BLA_TEXTURE_WIDTH,
			height: BLA_TEXTURE_HEIGHT,
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

	async findGoodReferenceCenter(centerReal, centerImag, radius, requiredIterations, targetIterations, options, requestId) {
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
					radius,
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
				this.gmp.computeReferenceData(sReal, sImag, radius, requiredIterations, options),
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
			this.gmp.computeReferenceData(bestCenterReal, bestCenterImag, radius, targetIterations, options),
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

				referenceData.stripeAveragePresum = this.computeStripeAveragePresum(
					referenceData.orbit,
					referenceData.polynomialLimit,
				);
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
				this.orbitTextureData = this.buildOrbitTextureData(referenceData.orbit);
				this.blaTableData = this.buildBLATable(referenceData.orbit);
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
