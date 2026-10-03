import {
	DEEP_ZOOM_THRESHOLD,
	BASE_ITERATIONS,
	DEEP_MIN_ITERATIONS,
	DEEP_MAX_ITERATIONS,
	DEEP_ITERATION_ZOOM_FACTOR,
	DEEP_ZOOM_PREPARATION_MARGIN_EXPONENT,
	DEEP_REFERENCE_ITERATION_HEADROOM_EXPONENT,
	DEEP_REFERENCE_ITERATION_QUANTUM,
} from '../config.js';
import { REFERENCE_ORBIT_RUNOFF } from '../shaderCommon.js';
export function getStandardIterationBudget(zoom) {
	// Ramp iteration budget toward the deep floor across the preparation margin.
	const rampStartZoom = DEEP_ZOOM_THRESHOLD - DEEP_ZOOM_PREPARATION_MARGIN_EXPONENT;
	if (zoom <= rampStartZoom) return BASE_ITERATIONS;
	if (zoom > DEEP_ZOOM_THRESHOLD) return getDeepIterationBudget(zoom);
	const rampProgress = (zoom - rampStartZoom) / DEEP_ZOOM_PREPARATION_MARGIN_EXPONENT;
	const target = Math.ceil(BASE_ITERATIONS * Math.pow(DEEP_MIN_ITERATIONS / BASE_ITERATIONS, rampProgress));
	return Math.min(DEEP_MIN_ITERATIONS, target);
}

export function getDeepIterationBudget(zoom) {
	// Continuous so per-frame iter growth shows as 0-1 newly-escaping pixels at most,
	// not as a 256-step jump that fills a band of pixels at once. The reference orbit
	// is sized with DEEP_REFERENCE_ITERATION_HEADROOM_EXPONENT extra zoom units worth
	// of iterations on top of this, so orbit recomputes don't fire as u_iterations
	// ticks up — only when the user pans or radically shifts zoom.
	const target = Math.ceil(
		DEEP_MIN_ITERATIONS + Math.max(0, zoom - DEEP_ZOOM_THRESHOLD) * DEEP_ITERATION_ZOOM_FACTOR,
	);
	return Math.min(DEEP_MAX_ITERATIONS, Math.max(DEEP_MIN_ITERATIONS, target));
}

export function getReferenceIterationCount(zoom, currentDeepIterations) {
	// Round up to a coarse quantum so the trigger comparison in referenceIterationsBelow
	// (stored < target) doesn't fire every zoom unit. With u_iterations continuous and
	// the per-zoom-unit target growing by DEEP_ITERATION_ZOOM_FACTOR, a fine-grained
	// target would force a recompute every frame of zooming, and each recompute is a
	// visible jump (findGoodReferenceCenter may shift the center, u_referenceOffset
	// changes, every pixel sees a different reference). The quantum here amortizes
	// each (expensive) GMP compute across many zoom units of zooming.
	// Runoff rides on top of the quantized budget so it survives the iteration cap,
	// where headroom no longer adds anything.
	const headroomZoom = Math.max(zoom, DEEP_ZOOM_THRESHOLD) + DEEP_REFERENCE_ITERATION_HEADROOM_EXPONENT;
	const target = getDeepIterationBudget(headroomZoom);
	const quantized = Math.ceil(target / DEEP_REFERENCE_ITERATION_QUANTUM) * DEEP_REFERENCE_ITERATION_QUANTUM;
	return Math.max(currentDeepIterations, quantized) + REFERENCE_ORBIT_RUNOFF;
}
