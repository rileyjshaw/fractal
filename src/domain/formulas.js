export const FORMULAS = Object.freeze([
	{ name: 'Julia', seedsFromCenter: true, folded: false },
	{ name: 'Mandelbrot', seedsFromCenter: false, folded: false },
	{ name: 'Burning Ship', seedsFromCenter: false, folded: true },
	{ name: 'Mandala', seedsFromCenter: true, folded: true },
]);
export const MIN_EXPONENT = 2;
export const MAX_EXPONENT = 16;
export function formulaKey(state) {
	const formula = FORMULAS[state.fractalType];
	return [
		state.fractalType,
		state.exponent,
		...(formula?.seedsFromCenter ? [state.cReal, state.cImaginary] : []),
	].join('|');
}
