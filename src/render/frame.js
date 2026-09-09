import { formulaKey } from '../domain/formulas.js';
import { METRIC_SCHEMA } from './metric.js';
export function describeFrame(state, width, height, reference = null) {
	return Object.freeze({
		formula: formulaKey(state),
		centerRealExact: state.centerRealExact,
		centerImagExact: state.centerImagExact,
		radiusExact: state.radiusExact,
		iterations: state.deepIterations,
		escapeRadius: state.escapeRadius,
		precision: state.precision,
		width,
		height,
		reference,
		schema: METRIC_SCHEMA,
	});
}
export function frameCompatible(frame, state, width, height) {
	return (
		!!frame &&
		frame.schema === METRIC_SCHEMA &&
		frame.formula === formulaKey(state) &&
		frame.escapeRadius === state.escapeRadius &&
		frame.width === width &&
		frame.height === height
	);
}
export function previewCovered(transform, width, height) {
	if (!transform) return false;
	const { scale, offsetReal, offsetImag } = transform;
	const min = Math.min(width, height),
		x = width / min,
		y = height / min;
	return (
		Number.isFinite(scale) &&
		scale > 0 &&
		Math.abs(offsetReal) + scale * x <= x + 1e-6 &&
		Math.abs(offsetImag) + scale * y <= y + 1e-6
	);
}
