import { decimalOrder, logDecimal } from '../math/precision.js';
import { getRadiusExactForZoom } from '../viewMath.js';
export const MAX_ZOOM = 400 / Math.log10(2);
const limits = {
	zoom: [0, MAX_ZOOM],
	exponent: [2, 16],
	fractalType: [0, 3],
	cReal: [-2.5, 2.5],
	cImaginary: [-2.5, 2.5],
	escapeRadius: [0.8, 2],
	colorScale: [0.02, 8],
	slopeLightAngle: [0, 360],
	slopeLightHeight: [0.1, 4],
	slopeLightIntensity: [0, 2],
	speed: [0.1, 8],
};
const flags = new Set(['forceHelp', 'slopeShading', 'stripeAverage', 'isPlaying']);
export function validateStatePatch(patch, current, paletteIds = []) {
	const result = {};
	for (const [key, value] of Object.entries(patch)) {
		if (!(key in current)) continue;
		if (['deepCenterReal', 'deepCenterImag', 'deepRadius'].includes(key)) {
			const text = String(value).trim(),
				order = decimalOrder(text);
			if (text.length > 2000 || Number.isNaN(order)) continue;
			if (key === 'deepRadius' && (text.startsWith('-') || !Number.isFinite(order) || order < -401 || order > 1))
				continue;
			if (key !== 'deepRadius' && order > 3) continue;
			result[key] = text;
			continue;
		}
		if (key === 'paletteId') {
			if (paletteIds.includes(value)) result[key] = value;
			continue;
		}
		if (typeof value !== 'number' || !Number.isFinite(value)) continue;
		if (flags.has(key)) {
			if (value === 0 || value === 1) result[key] = value;
			continue;
		}
		if (key === 'animationDirection') {
			if (value === -1 || value === 1) result[key] = value;
			continue;
		}
		if ((key === 'exponent' || key === 'fractalType') && !Number.isInteger(value)) continue;
		const range = limits[key];
		result[key] = range ? Math.max(range[0], Math.min(range[1], value)) : value;
	}
	return result;
}
// Exact decimal centers are canonical. Legacy X/Y are only a projection for
// shallow interpolation and backwards-compatible links; never derive deep pans from them.
export function reconcileCamera(current, patch) {
	const next = { ...current, ...patch };
	if ('deepCenterReal' in patch || 'deepCenterImag' in patch) {
		next.xPosition = Number(next.deepCenterReal) / 2;
		next.yPosition = Number(next.deepCenterImag) / 2;
	} else if ('xPosition' in patch || 'yPosition' in patch) {
		next.deepCenterReal = String(next.xPosition * 2);
		next.deepCenterImag = String(next.yPosition * 2);
	}
	if ('zoom' in patch && !('deepRadius' in patch)) next.deepRadius = getRadiusExactForZoom(next.zoom);
	// Explicit radius and zoom must describe the same scale; preserve its decimal
	// value and derive the approximate UI zoom when inconsistent.
	if ('deepRadius' in patch) {
		const logRadius = logDecimal(next.deepRadius) / Math.LN2;
		if (Math.abs(1 - logRadius - next.zoom) > 0.01) next.zoom = Math.max(0, Math.min(MAX_ZOOM, 1 - logRadius));
	}
	return next;
}
