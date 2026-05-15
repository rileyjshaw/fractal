import { init } from 'gmp-wasm';

const DEFAULT_PRECISION = 1200;
const ORBIT_CAPACITY = Math.floor((1024 * 1024) / 3);
const FRACTAL_TYPE_JULIA = 0;

function cloneWide([mantissa, exponent]) {
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

function multiplyWide(a, b) {
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

function maxAbsWide(a, b) {
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

function toFloat(wide) {
	return wide[0] * Math.pow(2, wide[1]);
}

function decomposeFloat(value) {
	if (value === 0) {
		return [0, 0];
	}

	const exponent = Math.floor(Math.log2(Math.abs(value))) + 1;
	return [value / Math.pow(2, exponent), exponent];
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
				if (this.binding.mpfr_get_d(escapeMagnitude, 0) > 400) {
					break;
				}
			}

			if (actualIterations === 0) {
				throw new Error('No iterations completed in orbit computation');
			}

			const polyScaleExponent = maxAbsWide(polynomial[0], polynomial[1])[1];
			const polyScale = [1, -polyScaleExponent];
			const [radiusMantissa, radiusExponent] = radiusWide;
			const linearScale = [radiusMantissa, 0];
			const quadraticScale = [radiusMantissa * radiusMantissa, radiusExponent];
			const cubicScale = [radiusMantissa * radiusMantissa * radiusMantissa, radiusExponent * 2];

			return {
				orbit: orbit.subarray(0, actualIterations * 3),
				orbitLength: actualIterations,
				poly1: new Float32Array([
					toFloat(multiplyWide(polyScale, multiplyWide(linearScale, polynomial[0]))),
					toFloat(multiplyWide(polyScale, multiplyWide(linearScale, polynomial[1]))),
					toFloat(multiplyWide(polyScale, multiplyWide(quadraticScale, polynomial[2]))),
					toFloat(multiplyWide(polyScale, multiplyWide(quadraticScale, polynomial[3]))),
				]),
				poly2: new Float32Array([
					toFloat(multiplyWide(polyScale, multiplyWide(cubicScale, polynomial[4]))),
					toFloat(multiplyWide(polyScale, multiplyWide(cubicScale, polynomial[5]))),
					polynomialLimit,
					polyScaleExponent,
				]),
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

	computeReferenceOrbit(centerReal, centerImag, iterations) {
		return this.computeReferenceData(centerReal, centerImag, 1, iterations).orbit;
	}

	cleanup() {
		this.binding = null;
		this.initialized = false;
	}
}
