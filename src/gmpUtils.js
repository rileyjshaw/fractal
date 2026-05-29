import { init } from 'gmp-wasm';

const DEFAULT_PRECISION = 1200;
const ORBIT_CAPACITY = Math.floor((1024 * 1024) / 3);
const FRACTAL_TYPE_JULIA = 0;
const FRACTAL_TYPE_MANDELBROT = 1;
// The deep shader raises the effective bailout to 64 when stripe averaging is
// enabled, so reference orbits must not stop at the old |z| > 20 threshold.
const REFERENCE_ESCAPE_MAGNITUDE_SQ = 64 * 64;
// Multipliers applied to the detected base period when trying Newton. Higher
// multiples have more periodic points (period 2p has more than period p), giving
// more chances at finding one with high cycle min |Z| (less glitch-prone) and
// within the Newton bound — also improves recompute robustness when Newton on
// the base period would bound out.
const NEWTON_PERIOD_MULTIPLIERS = [1, 2, 4, 8];

export function cloneWide([mantissa, exponent]) {
	return [mantissa, exponent];
}

function addWide(a, b) {
	let [am, ae] = a;
	let [bm, be] = b;
	const resultExponent = Math.max(ae, be);
	if (resultExponent > ae) {
		am *= Math.pow(2, ae - resultExponent);
	} else {
		bm *= Math.pow(2, be - resultExponent);
	}
	return [am + bm, resultExponent];
}

function subtractWide(a, b) {
	let [am, ae] = a;
	let [bm, be] = b;
	const resultExponent = Math.max(ae, be);
	if (resultExponent > ae) {
		am *= Math.pow(2, ae - resultExponent);
	} else {
		bm *= Math.pow(2, be - resultExponent);
	}
	return [am - bm, resultExponent];
}

export function multiplyWide(a, b) {
	const [am, ae] = a;
	const [bm, be] = b;
	let mantissa = am * bm;
	let exponent = ae + be;

	if (mantissa !== 0) {
		const mantissaExponent = Math.round(Math.log2(Math.abs(mantissa)));
		mantissa /= Math.pow(2, mantissaExponent);
		exponent += mantissaExponent;
	}

	return [mantissa, exponent];
}

export function maxAbsWide(a, b) {
	let [am, ae] = a;
	let [bm, be] = b;
	const resultExponent = Math.max(ae, be);
	if (resultExponent > ae) {
		am *= Math.pow(2, ae - resultExponent);
	} else {
		bm *= Math.pow(2, be - resultExponent);
	}
	return [Math.max(Math.abs(am), Math.abs(bm)), resultExponent];
}

function greaterThanWide(a, b) {
	let [am, ae] = a;
	let [bm, be] = b;
	const resultExponent = Math.max(ae, be);
	if (resultExponent > ae) {
		am *= Math.pow(2, ae - resultExponent);
	} else {
		bm *= Math.pow(2, be - resultExponent);
	}
	return am > bm;
}

export function toFloat(wide) {
	return wide[0] * Math.pow(2, wide[1]);
}

export class GMPUtils {
	constructor() {
		this.binding = null;
		this.initialized = false;
	}

	async init() {
		if (this.initialized) return;

		const { binding } = await init();
		this.binding = binding;
		this.initialized = true;
	}

	setMPFRValue(mpfr, value) {
		if (typeof value === 'string') {
			const result = this.binding.mpfr_set_string(mpfr, value, 10, 0);
			if (result !== 0) {
				throw new Error(`Invalid MPFR value: ${value}`);
			}
		} else {
			if (!Number.isFinite(value)) {
				throw new Error(`Invalid MPFR value: ${value}`);
			}
			this.binding.mpfr_set_d(mpfr, value, 0);
		}
	}

	createMPFR(value = 0, precision = DEFAULT_PRECISION) {
		if (!this.binding) {
			throw new Error('GMP-WASM not initialized');
		}

		const mpfr = this.binding.mpfr_t();
		let initialized = false;
		try {
			this.binding.mpfr_init2(mpfr, precision);
			initialized = true;
			this.setMPFRValue(mpfr, value);
		} catch (error) {
			if (initialized) {
				this.binding.mpfr_clear(mpfr);
			}
			this.binding.mpfr_t_free(mpfr);
			throw error;
		}
		return mpfr;
	}

	disposeMPFR(...values) {
		values.forEach(value => {
			if (!value) return;
			this.binding.mpfr_clear(value);
			this.binding.mpfr_t_free(value);
		});
	}

	toDecimalString(mpfr) {
		if (!this.binding) {
			throw new Error('GMP-WASM not initialized');
		}
		return this.binding.mpfr_to_string(mpfr, 10, 0, false);
	}

	decomposeValue(value, precision = DEFAULT_PRECISION) {
		if (!this.binding) {
			throw new Error('GMP-WASM not initialized');
		}

		const mpfr = this.createMPFR(value, precision);
		const exponentPointer = this.binding.malloc(8);
		try {
			const exponent = this.binding.mpfr_get_exp(mpfr);
			const mantissa = this.binding.mpfr_get_d_2exp(exponentPointer, mpfr, 0);
			return [mantissa, exponent];
		} finally {
			this.binding.free(exponentPointer);
			this.disposeMPFR(mpfr);
		}
	}

	scaleValue(value, factor, precision = DEFAULT_PRECISION) {
		if (!this.binding) {
			throw new Error('GMP-WASM not initialized');
		}

		const scaledValue = this.createMPFR(value, precision);
		let factorValue = null;
		try {
			if (typeof factor === 'string') {
				factorValue = this.createMPFR(factor, precision);
				this.binding.mpfr_mul(scaledValue, scaledValue, factorValue, 0);
			} else {
				this.binding.mpfr_mul_d(scaledValue, scaledValue, factor, 0);
			}
			return this.toDecimalString(scaledValue);
		} finally {
			this.disposeMPFR(scaledValue, factorValue);
		}
	}

	computeViewTransform(
		currentCenterReal,
		currentCenterImag,
		currentRadius,
		sourceCenterReal,
		sourceCenterImag,
		sourceRadius,
		precision = DEFAULT_PRECISION,
	) {
		if (!this.binding) {
			throw new Error('GMP-WASM not initialized');
		}

		let currentReal = null;
		let currentImag = null;
		let sourceReal = null;
		let sourceImag = null;
		let currentRadiusValue = null;
		let sourceRadiusValue = null;
		let offsetReal = null;
		let offsetImag = null;
		let scale = null;

		try {
			currentReal = this.createMPFR(currentCenterReal, precision);
			currentImag = this.createMPFR(currentCenterImag, precision);
			sourceReal = this.createMPFR(sourceCenterReal, precision);
			sourceImag = this.createMPFR(sourceCenterImag, precision);
			currentRadiusValue = this.createMPFR(currentRadius, precision);
			sourceRadiusValue = this.createMPFR(sourceRadius, precision);
			offsetReal = this.createMPFR(0, precision);
			offsetImag = this.createMPFR(0, precision);
			scale = this.createMPFR(0, precision);

			this.binding.mpfr_sub(offsetReal, currentReal, sourceReal, 0);
			this.binding.mpfr_sub(offsetImag, currentImag, sourceImag, 0);
			this.binding.mpfr_div(offsetReal, offsetReal, sourceRadiusValue, 0);
			this.binding.mpfr_div(offsetImag, offsetImag, sourceRadiusValue, 0);
			this.binding.mpfr_div(scale, currentRadiusValue, sourceRadiusValue, 0);

			return {
				offsetReal: this.binding.mpfr_get_d(offsetReal, 0),
				offsetImag: this.binding.mpfr_get_d(offsetImag, 0),
				scale: this.binding.mpfr_get_d(scale, 0),
			};
		} finally {
			this.disposeMPFR(
				currentReal,
				currentImag,
				sourceReal,
				sourceImag,
				currentRadiusValue,
				sourceRadiusValue,
				offsetReal,
				offsetImag,
				scale,
			);
		}
	}

	translateCenter(centerReal, centerImag, radius, deltaReal, deltaImag, precision = DEFAULT_PRECISION) {
		if (!this.binding) {
			throw new Error('GMP-WASM not initialized');
		}

		let real = null;
		let imag = null;
		let radiusValue = null;
		let deltaRealValue = null;
		let deltaImagValue = null;

		try {
			real = this.createMPFR(centerReal, precision);
			imag = this.createMPFR(centerImag, precision);
			radiusValue = this.createMPFR(radius, precision);
			deltaRealValue = this.createMPFR(0, precision);
			deltaImagValue = this.createMPFR(0, precision);

			this.binding.mpfr_mul_d(deltaRealValue, radiusValue, deltaReal, 0);
			this.binding.mpfr_mul_d(deltaImagValue, radiusValue, deltaImag, 0);
			this.binding.mpfr_add(real, real, deltaRealValue, 0);
			this.binding.mpfr_add(imag, imag, deltaImagValue, 0);

			return {
				centerReal: this.toDecimalString(real),
				centerImag: this.toDecimalString(imag),
			};
		} finally {
			this.disposeMPFR(real, imag, radiusValue, deltaRealValue, deltaImagValue);
		}
	}

	computeReferenceData(
		centerReal,
		centerImag,
		radius,
		iterations,
		{ fractalType = 1, cReal = 0, cImaginary = 0 } = {},
	) {
		if (!this.binding) {
			throw new Error('GMP-WASM not initialized');
		}

		const orbit = new Float32Array(Math.min(iterations, ORBIT_CAPACITY) * 3);
		let x = null;
		let y = null;
		let cx = null;
		let cy = null;
		let x2 = null;
		let y2 = null;
		let xy = null;
		let temp = null;
		let escapeMagnitude = null;
		let exponentPointer = null;

		try {
			const isJulia = fractalType === FRACTAL_TYPE_JULIA;
			x = this.createMPFR(isJulia ? centerReal : 0);
			y = this.createMPFR(isJulia ? centerImag : 0);
			cx = this.createMPFR(isJulia ? cReal : centerReal);
			cy = this.createMPFR(isJulia ? cImaginary : centerImag);
			x2 = this.createMPFR();
			y2 = this.createMPFR();
			xy = this.createMPFR();
			temp = this.createMPFR();
			escapeMagnitude = this.createMPFR();
			exponentPointer = this.binding.malloc(8);

			const radiusWide = this.decomposeValue(radius);

			let bx = [0, 0];
			let by = [0, 0];
			let cxPoly = [0, 0];
			let cyPoly = [0, 0];
			let dxPoly = [0, 0];
			let dyPoly = [0, 0];
			let polynomial = [
				cloneWide(bx),
				cloneWide(by),
				cloneWide(cxPoly),
				cloneWide(cyPoly),
				cloneWide(dxPoly),
				cloneWide(dyPoly),
			];
			let polynomialLimit = 0;
			let polynomialStable = true;

			let actualIterations = 0;

			for (let i = 0; i < iterations && i < ORBIT_CAPACITY; i++) {
				const xExponent = this.binding.mpfr_get_exp(x);
				const yExponent = this.binding.mpfr_get_exp(y);
				const scaleExponent = Math.max(xExponent, yExponent);

				if (scaleExponent < -10000) {
					orbit[3 * i] = 0;
					orbit[3 * i + 1] = 0;
					orbit[3 * i + 2] = 0;
				} else {
					orbit[3 * i] =
						this.binding.mpfr_get_d_2exp(exponentPointer, x, 0) / Math.pow(2, scaleExponent - xExponent);
					orbit[3 * i + 1] =
						this.binding.mpfr_get_d_2exp(exponentPointer, y, 0) / Math.pow(2, scaleExponent - yExponent);
					orbit[3 * i + 2] = scaleExponent;
				}

				const fx = [orbit[3 * i], orbit[3 * i + 2]];
				const fy = [orbit[3 * i + 1], orbit[3 * i + 2]];

				const previousPolynomial = [
					cloneWide(bx),
					cloneWide(by),
					cloneWide(cxPoly),
					cloneWide(cyPoly),
					cloneWide(dxPoly),
					cloneWide(dyPoly),
				];

				this.binding.mpfr_mul(x2, x, x, 0);
				this.binding.mpfr_mul(y2, y, y, 0);
				this.binding.mpfr_sub(temp, x2, y2, 0);
				this.binding.mpfr_add(temp, temp, cx, 0);

				this.binding.mpfr_mul(xy, x, y, 0);
				this.binding.mpfr_mul_d(xy, xy, 2, 0);
				this.binding.mpfr_add(xy, xy, cy, 0);

				this.binding.mpfr_set(x, temp, 0);
				this.binding.mpfr_set(y, xy, 0);

				[bx, by, cxPoly, cyPoly, dxPoly, dyPoly] = [
					addWide(multiplyWide([2, 0], subtractWide(multiplyWide(fx, bx), multiplyWide(fy, by))), [1, 0]),
					multiplyWide([2, 0], addWide(multiplyWide(fx, by), multiplyWide(fy, bx))),
					subtractWide(
						addWide(
							multiplyWide([2, 0], subtractWide(multiplyWide(fx, cxPoly), multiplyWide(fy, cyPoly))),
							multiplyWide(bx, bx),
						),
						multiplyWide(by, by),
					),
					addWide(
						multiplyWide([2, 0], addWide(multiplyWide(fx, cyPoly), multiplyWide(fy, cxPoly))),
						multiplyWide(multiplyWide([2, 0], bx), by),
					),
					multiplyWide(
						[2, 0],
						addWide(
							subtractWide(multiplyWide(fx, dxPoly), multiplyWide(fy, dyPoly)),
							subtractWide(multiplyWide(cxPoly, bx), multiplyWide(cyPoly, by)),
						),
					),
					multiplyWide(
						[2, 0],
						addWide(
							addWide(
								addWide(multiplyWide(fx, dyPoly), multiplyWide(fy, dxPoly)),
								multiplyWide(cxPoly, by),
							),
							multiplyWide(cyPoly, bx),
						),
					),
				];

				if (
					i === 0 ||
					greaterThanWide(
						maxAbsWide(cxPoly, cyPoly),
						multiplyWide(multiplyWide([1000, 0], radiusWide), maxAbsWide(dxPoly, dyPoly)),
					)
				) {
					if (polynomialStable) {
						polynomial = previousPolynomial;
						polynomialLimit = i;
					}
				} else {
					polynomialStable = false;
				}

				this.binding.mpfr_mul(temp, x, x, 0);
				this.binding.mpfr_mul(xy, y, y, 0);
				this.binding.mpfr_add(escapeMagnitude, temp, xy, 0);

				actualIterations = i + 1;
				if (this.binding.mpfr_get_d(escapeMagnitude, 0) > REFERENCE_ESCAPE_MAGNITUDE_SQ) {
					break;
				}
			}

			if (actualIterations === 0) {
				throw new Error('No iterations completed in orbit computation');
			}

			const [radiusMantissa, radiusExponent] = radiusWide;

			// Return the polynomial in its un-radius-scaled wide form. The radius factors
			// (linear/quadratic/cubic) and the polyScale-exponent normalization are applied
			// per-frame in deepZoom.getShaderUniforms against the *current* view radius;
			// baking them in here would lock the polynomial to the reference-time radius
			// and distort the perturbation evaluation as the user zooms.
			return {
				orbit: orbit.subarray(0, actualIterations * 3),
				orbitLength: actualIterations,
				polynomialWide: polynomial,
				polynomialLimit,
				radiusMantissa,
				radiusExponent,
			};
		} finally {
			if (exponentPointer) {
				this.binding.free(exponentPointer);
			}
			this.disposeMPFR(x, y, cx, cy, x2, y2, xy, temp, escapeMagnitude);
		}
	}

	// Find a periodic point of the z² + c iteration near the requested center.
	// Periodic points have orbit length effectively infinite (the orbit cycles without
	// escaping), so they make ideal reference centers — grid sampling can miss tiny
	// features, but Newton on the period equation converges to the periodic point's
	// mathematical center deterministically given a nearby starting guess.
	//
	// Both Mandelbrot and Julia are supported, with slightly different equations:
	//
	//   Mandelbrot: solve g_p(c) = f^p_c(0) = 0 in c. Each iter starts at Z_0 = 0
	//     and uses the candidate c. Derivative w.r.t. c: g'_{i+1} = 2 g_i g'_i + 1.
	//     A solution is the nucleus of a period-p hyperbolic component (minibrot).
	//
	//   Julia: solve h_p(z) = f^p_c(z) − z = 0 in z, with c fixed at the user's
	//     parameter. Each iter starts at Z_0 = the candidate z. Derivative w.r.t. z:
	//     D_{i+1} = 2 Z_i D_i (no +1 — c doesn't depend on z). A solution is a
	//     period-p periodic point of the Julia set.
	//
	// In both cases period detection runs first by iterating the orbit at the
	// requested center and finding argmin of a near-return distance (|Z_p| for
	// Mandelbrot, |Z_p − z_0| for Julia).
	//
	// Returns {centerReal, centerImag, period, residualSq} on success or null if no
	// nearby periodic point found / Newton diverged outside maxRadius.
	// Async so the render loop can paint while Newton iterates — at long periods
	// a single Newton iteration can be tens of ms and the full run hundreds.
	async findPeriodicReferenceCenter(centerReal, centerImag, maxRadius, options = {}) {
		if (!this.binding) {
			throw new Error('GMP-WASM not initialized');
		}

		const {
			fractalType = FRACTAL_TYPE_MANDELBROT,
			cReal = 0,
			cImaginary = 0,
			maxPeriod = 1024,
			minPeriod = 1,
			newtonIterations = 24,
			// Try Newton on these multiples of the detected base period, score each
			// converged result by orbit cycle min |Z|², pick the best. Higher multiples
			// can find periodic points with cycle min |Z| further from 0 (less glitch-
			// prone in the perturbation shader) and improve recompute robustness when
			// Newton on the base period bounds out.
			periodMultipliers = NEWTON_PERIOD_MULTIPLIERS,
			// Near-return distance² threshold below which p is accepted as a period.
			// Tuned conservatively; the requested center is offset from the true
			// periodic point by up to a few view radii.
			returnMagnitudeSqThreshold = 0.25,
			// Residual threshold for accepting Newton's converged result.
			residualSqThreshold = 1e-20,
			// Early-termination tolerance: stop iterating when the Newton step shrinks
			// below this magnitude. Newton converges quadratically, so once the step is
			// small further iterations only add noise.
			newtonStepSqTolerance = 1e-60,
			// Yield to the browser between Newton iterations so the render loop can
			// paint old-reference frames while we converge.
			shouldYield = true,
			// Optional callback the caller uses to abort an in-flight Newton when its
			// result is no longer needed (e.g. the user has panned to a new view).
			// Checked at each yield point; returning true bails out with null.
			isAborted = () => false,
		} = options;

		const isJulia = fractalType === FRACTAL_TYPE_JULIA;

		// Naming convention for both modes:
		//   (cx, cy)   the variable Newton solves for (Mandelbrot c, Julia z).
		//   (origCx)   the requested center (used for bounds + period detection start).
		//   (juliaCx, juliaCy)  the Julia c parameter, fixed throughout Newton.
		//   (gx, gy)   the iterated value Z_p (or g_p(c) in Mandelbrot terms).
		//   (gpx, gpy) the derivative D_p (g'_p in Mandelbrot terms).
		let cx = null,
			cy = null,
			origCx = null,
			origCy = null,
			juliaCx = null,
			juliaCy = null,
			maxRadiusValue = null;
		let gx = null,
			gy = null,
			gpx = null,
			gpy = null;
		let t1 = null,
			t2 = null,
			t3 = null,
			t4 = null;
		let dcx = null,
			dcy = null,
			denom = null;
		let residualX = null,
			residualY = null,
			denomX = null,
			denomY = null;
		let diffX = null,
			diffY = null,
			distSq = null,
			distLimit = null;

		try {
			cx = this.createMPFR(centerReal);
			cy = this.createMPFR(centerImag);
			origCx = this.createMPFR(centerReal);
			origCy = this.createMPFR(centerImag);
			juliaCx = this.createMPFR(isJulia ? cReal : 0);
			juliaCy = this.createMPFR(isJulia ? cImaginary : 0);
			maxRadiusValue = this.createMPFR(maxRadius);
			gx = this.createMPFR(0);
			gy = this.createMPFR(0);
			gpx = this.createMPFR(0);
			gpy = this.createMPFR(0);
			t1 = this.createMPFR();
			t2 = this.createMPFR();
			t3 = this.createMPFR();
			t4 = this.createMPFR();
			dcx = this.createMPFR();
			dcy = this.createMPFR();
			denom = this.createMPFR();
			residualX = this.createMPFR();
			residualY = this.createMPFR();
			denomX = this.createMPFR();
			denomY = this.createMPFR();
			diffX = this.createMPFR();
			diffY = this.createMPFR();
			distSq = this.createMPFR();
			distLimit = this.createMPFR();

			this.binding.mpfr_mul(distLimit, maxRadiusValue, maxRadiusValue, 0);

			// --- Phase 1: detect period via near-return.
			//   Mandelbrot: Z_0 = 0,    parameter = origC, look for |Z_p| small.
			//   Julia:      Z_0 = origC, parameter = juliaC, look for |Z_p − origC| small.
			if (isJulia) {
				this.binding.mpfr_set(gx, origCx, 0);
				this.binding.mpfr_set(gy, origCy, 0);
			} else {
				this.binding.mpfr_set_d(gx, 0, 0);
				this.binding.mpfr_set_d(gy, 0, 0);
			}

			let bestPeriod = 0;
			let bestMagSq = Infinity;

			for (let i = 1; i <= maxPeriod; i++) {
				this.binding.mpfr_mul(t1, gx, gx, 0);
				this.binding.mpfr_mul(t2, gy, gy, 0);
				this.binding.mpfr_sub(t3, t1, t2, 0);
				this.binding.mpfr_add(t3, t3, isJulia ? juliaCx : origCx, 0);
				this.binding.mpfr_mul(t4, gx, gy, 0);
				this.binding.mpfr_mul_d(t4, t4, 2, 0);
				this.binding.mpfr_add(t4, t4, isJulia ? juliaCy : origCy, 0);
				this.binding.mpfr_set(gx, t3, 0);
				this.binding.mpfr_set(gy, t4, 0);

				let nx, ny;
				if (isJulia) {
					this.binding.mpfr_sub(t1, gx, origCx, 0);
					this.binding.mpfr_sub(t2, gy, origCy, 0);
					nx = this.binding.mpfr_get_d(t1, 0);
					ny = this.binding.mpfr_get_d(t2, 0);
				} else {
					nx = this.binding.mpfr_get_d(gx, 0);
					ny = this.binding.mpfr_get_d(gy, 0);
				}
				if (!Number.isFinite(nx) || !Number.isFinite(ny)) break;
				const magSq = nx * nx + ny * ny;
				// Stop early if orbit escaped — past escape values diverge to infinity
				// and any min thereafter is meaningless. The escape check uses |Z|² (not
				// the near-return distance) because that's what defines escape.
				const zx = this.binding.mpfr_get_d(gx, 0);
				const zy = this.binding.mpfr_get_d(gy, 0);
				if (zx * zx + zy * zy > REFERENCE_ESCAPE_MAGNITUDE_SQ) break;
				if (i >= minPeriod && magSq < bestMagSq) {
					bestMagSq = magSq;
					bestPeriod = i;
				}
			}

			if (bestPeriod === 0 || bestMagSq > returnMagnitudeSqThreshold) {
				return null;
			}
			const basePeriod = bestPeriod;

			// --- Phase 2: try Newton on multiple period multiples, score, pick best.
			//   Mandelbrot Newton: c_{n+1} = c_n − g_p(c) / g_p'(c).
			//   Julia Newton:      z_{n+1} = z_n − (Z_p − z) / (D_p − 1).
			//
			// The score is min |Z|² over orbit[0..period-1]. For Julia higher score means
			// the cycle stays further from the origin → less glitch-prone in the perturbation
			// shader. For Mandelbrot orbit[0] = 0 so all candidates score 0 — but multi-period
			// is still useful because Newton on multiples of the base period may converge
			// where Newton on the base bounds out (more periodic points to land on).
			const runNewtonForPeriod = async period => {
				// Reset c/z to the original requested center for a fresh Newton run.
				this.binding.mpfr_set(cx, origCx, 0);
				this.binding.mpfr_set(cy, origCy, 0);

				for (let n = 0; n < newtonIterations; n++) {
					if (shouldYield && n > 0) {
						await new Promise(resolve => setTimeout(resolve, 0));
						if (isAborted()) return false;
					}
					if (isJulia) {
						this.binding.mpfr_set(gx, cx, 0);
						this.binding.mpfr_set(gy, cy, 0);
						this.binding.mpfr_set_d(gpx, 1, 0);
						this.binding.mpfr_set_d(gpy, 0, 0);
					} else {
						this.binding.mpfr_set_d(gx, 0, 0);
						this.binding.mpfr_set_d(gy, 0, 0);
						this.binding.mpfr_set_d(gpx, 0, 0);
						this.binding.mpfr_set_d(gpy, 0, 0);
					}

					for (let p = 0; p < period; p++) {
						// Derivative update first (uses old Z).
						//   Mandelbrot: g'_{p+1} = 2 (g_p * g'_p) + 1.
						//   Julia:      D_{p+1}  = 2 (Z_p * D_p).
						this.binding.mpfr_mul(t1, gx, gpx, 0);
						this.binding.mpfr_mul(t2, gy, gpy, 0);
						this.binding.mpfr_sub(t3, t1, t2, 0);
						this.binding.mpfr_mul_d(t3, t3, 2, 0);
						if (!isJulia) this.binding.mpfr_add_d(t3, t3, 1, 0);
						this.binding.mpfr_mul(t1, gx, gpy, 0);
						this.binding.mpfr_mul(t2, gy, gpx, 0);
						this.binding.mpfr_add(t4, t1, t2, 0);
						this.binding.mpfr_mul_d(t4, t4, 2, 0);
						this.binding.mpfr_set(gpx, t3, 0);
						this.binding.mpfr_set(gpy, t4, 0);

						// Value update: Z_{p+1} = Z_p² + C.
						this.binding.mpfr_mul(t1, gx, gx, 0);
						this.binding.mpfr_mul(t2, gy, gy, 0);
						this.binding.mpfr_sub(t3, t1, t2, 0);
						this.binding.mpfr_add(t3, t3, isJulia ? juliaCx : cx, 0);
						this.binding.mpfr_mul(t4, gx, gy, 0);
						this.binding.mpfr_mul_d(t4, t4, 2, 0);
						this.binding.mpfr_add(t4, t4, isJulia ? juliaCy : cy, 0);
						this.binding.mpfr_set(gx, t3, 0);
						this.binding.mpfr_set(gy, t4, 0);
					}

					// Compose numerator/denominator for the Newton step.
					//   Mandelbrot: num = g(c) = (gx, gy);          denom = g'(c) = (gpx, gpy)
					//   Julia:      num = Z_p − z = (gx − cx, …);   denom = D_p − 1 = (gpx − 1, gpy)
					if (isJulia) {
						this.binding.mpfr_sub(residualX, gx, cx, 0);
						this.binding.mpfr_sub(residualY, gy, cy, 0);
						this.binding.mpfr_set_d(t1, 1, 0);
						this.binding.mpfr_sub(denomX, gpx, t1, 0);
						this.binding.mpfr_set(denomY, gpy, 0);
					} else {
						this.binding.mpfr_set(residualX, gx, 0);
						this.binding.mpfr_set(residualY, gy, 0);
						this.binding.mpfr_set(denomX, gpx, 0);
						this.binding.mpfr_set(denomY, gpy, 0);
					}

					// Newton step: dc = num / denom
					//   = ((numX * denomX + numY * denomY) + i (numY * denomX − numX * denomY))
					//     / (denomX² + denomY²)
					this.binding.mpfr_mul(t1, denomX, denomX, 0);
					this.binding.mpfr_mul(t2, denomY, denomY, 0);
					this.binding.mpfr_add(denom, t1, t2, 0);

					// If denominator collapses, Newton breaks down at this period.
					if (this.binding.mpfr_get_d(denom, 0) === 0) return false;

					this.binding.mpfr_mul(t1, residualX, denomX, 0);
					this.binding.mpfr_mul(t2, residualY, denomY, 0);
					this.binding.mpfr_add(dcx, t1, t2, 0);
					this.binding.mpfr_div(dcx, dcx, denom, 0);

					this.binding.mpfr_mul(t1, residualY, denomX, 0);
					this.binding.mpfr_mul(t2, residualX, denomY, 0);
					this.binding.mpfr_sub(dcy, t1, t2, 0);
					this.binding.mpfr_div(dcy, dcy, denom, 0);

					this.binding.mpfr_sub(cx, cx, dcx, 0);
					this.binding.mpfr_sub(cy, cy, dcy, 0);

					this.binding.mpfr_sub(diffX, cx, origCx, 0);
					this.binding.mpfr_sub(diffY, cy, origCy, 0);
					this.binding.mpfr_mul(t1, diffX, diffX, 0);
					this.binding.mpfr_mul(t2, diffY, diffY, 0);
					this.binding.mpfr_add(distSq, t1, t2, 0);
					if (this.binding.mpfr_cmp(distSq, distLimit) > 0) return false;

					const dcxD = this.binding.mpfr_get_d(dcx, 0);
					const dcyD = this.binding.mpfr_get_d(dcy, 0);
					if (
						Number.isFinite(dcxD) &&
						Number.isFinite(dcyD) &&
						dcxD * dcxD + dcyD * dcyD < newtonStepSqTolerance
					) {
						break;
					}
				}
				return true;
			};

			// Iterate the orbit at the current (cx, cy) for `period` steps, returning
			// the residual |Z_p (− z if Julia)|² AND the min |Z|² over the cycle.
			// Used both to verify Newton's convergence and to score candidates.
			const evaluateOrbitForCycle = period => {
				if (isJulia) {
					this.binding.mpfr_set(gx, cx, 0);
					this.binding.mpfr_set(gy, cy, 0);
				} else {
					this.binding.mpfr_set_d(gx, 0, 0);
					this.binding.mpfr_set_d(gy, 0, 0);
				}
				let cycleMinMagSq = Infinity;
				for (let p = 0; p < period; p++) {
					const zx = this.binding.mpfr_get_d(gx, 0);
					const zy = this.binding.mpfr_get_d(gy, 0);
					if (!Number.isFinite(zx) || !Number.isFinite(zy)) return { residualSq: Infinity, cycleMinMagSq: 0 };
					const magSq = zx * zx + zy * zy;
					if (magSq < cycleMinMagSq) cycleMinMagSq = magSq;
					this.binding.mpfr_mul(t1, gx, gx, 0);
					this.binding.mpfr_mul(t2, gy, gy, 0);
					this.binding.mpfr_sub(t3, t1, t2, 0);
					this.binding.mpfr_add(t3, t3, isJulia ? juliaCx : cx, 0);
					this.binding.mpfr_mul(t4, gx, gy, 0);
					this.binding.mpfr_mul_d(t4, t4, 2, 0);
					this.binding.mpfr_add(t4, t4, isJulia ? juliaCy : cy, 0);
					this.binding.mpfr_set(gx, t3, 0);
					this.binding.mpfr_set(gy, t4, 0);
				}
				if (isJulia) {
					this.binding.mpfr_sub(t1, gx, cx, 0);
					this.binding.mpfr_sub(t2, gy, cy, 0);
				} else {
					this.binding.mpfr_set(t1, gx, 0);
					this.binding.mpfr_set(t2, gy, 0);
				}
				this.binding.mpfr_mul(t3, t1, t1, 0);
				this.binding.mpfr_mul(t4, t2, t2, 0);
				this.binding.mpfr_add(t3, t3, t4, 0);
				const residualSq = this.binding.mpfr_get_d(t3, 0);
				return { residualSq, cycleMinMagSq };
			};

			let bestResult = null;
			let bestScore = -Infinity;

			for (const mult of periodMultipliers) {
				const tryPeriod = basePeriod * mult;
				if (tryPeriod > maxPeriod) break;
				if (isAborted()) return bestResult;

				const converged = await runNewtonForPeriod(tryPeriod);
				if (!converged) continue;

				const { residualSq, cycleMinMagSq } = evaluateOrbitForCycle(tryPeriod);
				if (!Number.isFinite(residualSq) || residualSq > residualSqThreshold) continue;

				if (cycleMinMagSq > bestScore) {
					bestScore = cycleMinMagSq;
					bestResult = {
						centerReal: this.toDecimalString(cx),
						centerImag: this.toDecimalString(cy),
						period: tryPeriod,
						residualSq,
						cycleMinMagSq,
					};
				}
			}

			return bestResult;
		} finally {
			this.disposeMPFR(
				cx,
				cy,
				origCx,
				origCy,
				juliaCx,
				juliaCy,
				maxRadiusValue,
				gx,
				gy,
				gpx,
				gpy,
				t1,
				t2,
				t3,
				t4,
				dcx,
				dcy,
				denom,
				residualX,
				residualY,
				denomX,
				denomY,
				diffX,
				diffY,
				distSq,
				distLimit,
			);
		}
	}

	cleanup() {
		this.binding = null;
		this.initialized = false;
	}
}
