import { logDecimal } from '../math/precision.js';
import { STRIPE_EWMA_ALPHA } from '../shaderCommon.js';
export const METRIC_SCHEMA = 1;
export const INVALID_METRIC = [-1, 0, 0, -1];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smoothstep = (a, b, x) => {
	const t = clamp((x - a) / (b - a), 0, 1);
	return t * t * (3 - 2 * t);
};
const pack = (brightness, normal = -1) =>
	Math.floor(clamp(brightness, 0, 3.999) * 1024 + 0.5) * 4096 +
	(normal < 0 ? 4095 : Math.floor((normal / (2 * Math.PI)) * 4094 + 0.5));
// CPU fallback metrics from an independently computed MPFR pixel orbit. Orbit
// values are rounded only after high-precision iteration; no reference deltas.
export function metricFromOrbit(orbit, state) {
	const analytic = state.exponent === 2 && state.fractalType < 2;
	let dx = state.fractalType === 0 ? 1 : 0,
		dy = 0,
		logD = 0;
	let stripe = 0.5,
		previous,
		min = 1e30,
		detail = 0,
		escape = null;
	const point = i => [orbit[i * 3] * 2 ** orbit[i * 3 + 2], orbit[i * 3 + 1] * 2 ** orbit[i * 3 + 2]];
	for (let i = 1; i < orbit.length / 3; i++) {
		const [x, y] = point(i),
			[px, py] = point(i - 1),
			mag = Math.hypot(x, y);
		if (!Number.isFinite(mag)) break;
		if (!escape && analytic) {
			const nx = 2 * (px * dx - py * dy) + (state.fractalType === 1 ? Math.exp(-logD) : 0);
			dy = 2 * (px * dy + py * dx);
			dx = nx;
			const scale = Math.hypot(dx, dy);
			if (scale > 1e15) {
				dx /= scale;
				dy /= scale;
				logD += Math.log(scale);
			}
		}
		previous = stripe;
		stripe += (0.5 + 0.5 * Math.sin(8 * Math.atan2(y, x)) - stripe) * STRIPE_EWMA_ALPHA;
		min = Math.min(min, mag * mag);
		detail += 1 / (1 + mag * mag);
		if (!escape && mag > state.escapeRadius) {
			const denominator = Math.abs(Math.log(state.escapeRadius)) < 1e-6 ? 1e-6 : Math.log(state.escapeRadius);
			const ratio = Math.log(mag) / denominator;
			const smooth = i - clamp(Math.log2(Math.max(ratio, 1e-6)), -1, 2);
			let normal = analytic ? Math.atan2(y * dx - x * dy, x * dx + y * dy) : -1;
			if (analytic && normal < 0) normal += 2 * Math.PI;
			let brightness;
			if (analytic) {
				const logDistance =
					Math.log(0.5 * mag * Math.max(Math.log(mag), 1e-6)) - Math.log(Math.hypot(dx, dy)) - logD;
				const radiusLog = logDecimal(state.radiusExact);
				const boundary = 1 - smoothstep(0.003, 0.12, Math.exp(clamp(logDistance - radiusLog, -30, 30)));
				brightness = 1 + 0.16 * boundary * smoothstep(4, 32, i);
			} else brightness = 1 + (0.82 + (0.34 * detail) / i - 1) * smoothstep(3, 24, i);
			escape = { smooth, normal, brightness, iteration: i };
		}
		if (escape && (mag > 64 || i - escape.iteration >= 32 || i === orbit.length / 3 - 1)) {
			const frac = 1 + Math.log2(Math.log(64 * 64) / Math.max(Math.log(mag * mag), 1e-6));
			const stripeOffset =
				(mag * mag <= 1.000001 ? stripe : previous + (stripe - previous) * clamp(frac, 0, 1)) * 32;
			return [escape.smooth, stripeOffset, pack(escape.brightness, escape.normal), 1];
		}
		if (!escape && i >= state.deepIterations) break;
	}
	if (escape) return [escape.smooth, stripe * 32, pack(escape.brightness, escape.normal), 1];
	const brightness = state.fractalType === 1 && state.exponent === 2 ? 1 : 0.6 + Math.exp(-4 * Math.sqrt(min));
	return [0, 0, pack(brightness), 0];
}

export function repairMetrics(gmp, pixels, state, width, height) {
	let repaired = 0;
	for (let index = 0; index < pixels.length; index += 4) {
		if (pixels[index + 3] >= 0 && pixels.subarray(index, index + 4).every(Number.isFinite)) continue;
		const pixel = index / 4,
			x = pixel % width,
			y = Math.floor(pixel / width),
			span = Math.min(width, height);
		const center = gmp.translateCenter(
			state.centerRealExact,
			state.centerImagExact,
			state.radiusExact,
			(2 * x + 1 - width) / span,
			(2 * y + 1 - height) / span,
		);
		const { orbit } = gmp.computeReferenceData(
			center.centerReal,
			center.centerImag,
			state.deepIterations + 34,
			state,
		);
		pixels.set(metricFromOrbit(orbit, state), index);
		repaired++;
	}
	return repaired;
}
