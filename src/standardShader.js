import { GLSL_IS_FINITE, GLSL_METRIC_SHARED, GLSL_PACK_CONSTANTS, N_COLORS } from './shaderCommon.js';

const FRACTAL_TYPE_JULIA = 0;
const FRACTAL_TYPE_MANDELBROT = 1;
const FRACTAL_TYPE_BURNING_SHIP = 2;

// z^N as an unrolled cmul chain. The exponent is baked into the shader variant, so the
// compiler sees straight-line code with no loop and no dynamic exponent uniform.
function glslPowerFunction(exponent) {
	const lines = ['vec2 cpowN(vec2 z) {', '\tvec2 p = z;'];
	for (let i = 1; i < exponent; i++) {
		lines.push('\tp = cmul(p, z);');
	}
	lines.push('\treturn p;', '}');
	return lines.join('\n');
}

// Brent-style cycle detection on exact float32 equality: an orbit that exactly revisits
// a previous state is deterministically trapped and can never escape, so bailing to
// interior is sound (no epsilon, no false positives). Attracting interiors collapse to
// exact float32 cycles quickly, sparing the budget.
function glslCycleCheck(interiorArg) {
	return `		if (all(equal(z, tortoise))) {
			return interiorMetric(${interiorArg});
		}
		if (i == nextTortoiseUpdate) {
			tortoise = z;
			nextTortoiseUpdate *= 2;
		}`;
}

// Standard iteration pass: outputs the per-pixel metric (smoothIters, stripeOffset,
// packed visual data, coverage) to an FBO. The downstream display shader
// (deepDisplayShader.js) reads this metric and applies the palette/lighting, so palette
// and lighting changes only re-run the cheap display pass.
//
// The fractal type and exponent are baked into the generated source: only the selected
// formula's iterate function is emitted, the power loop is unrolled, and every per-pixel
// formula branch is resolved at generation time. main.js recreates the renderer when
// either changes (ShaderPad recreation on a shared canvas is cheap).
export function generateStandardShader({ fractalType = 1, exponent = 2 } = {}) {
	const isJulia = fractalType === FRACTAL_TYPE_JULIA;
	const isMandelbrot = fractalType === FRACTAL_TYPE_MANDELBROT;
	const isShip = fractalType === FRACTAL_TYPE_BURNING_SHIP;
	const isAnalytic = isJulia || isMandelbrot;
	const isQuadratic = exponent === 2;
	// Quadratic analytic formulas carry a derivative for the distance estimate; all
	// other variants color via the orbit detail average (buildMetric).
	const hasDerivative = isAnalytic && isQuadratic;
	// Quadratic Mandelbrot keeps the flat interior so iterated pixels match the
	// cardioid/bulb early-out; everything else shades the interior by min |z|.
	const interiorArg = isMandelbrot && isQuadratic ? 'INTERIOR_FLAT' : 'minMagSq';

	const escapedReturn = hasDerivative
		? `return buildDistanceMetric(
		escapeIters,
		escapeZ,
		escapeDz,
		0.0,
		stripeEwma,
		previousStripeEwma,
		stripeSamples,
		stripeMagSq,
		detailSamples,
		logViewRadius,
		pixelRadius
	);`
		: `return buildMetric(
		escapeIters,
		detailTotal,
		detailSamples,
		stripeEwma,
		previousStripeEwma,
		stripeSamples,
		stripeMagSq,
		1.0
	);`;

	const analyticStep = hasDerivative
		? `vec2 previousZ = z;
		dz = cmul(vec2(2.0 * previousZ.x, 2.0 * previousZ.y), dz)${isMandelbrot ? ' + vec2(1.0, 0.0)' : ''};
		z = cmul(previousZ, previousZ) + c;`
		: `z = cpowN(z) + c;`;
	// The runoff repeats the orbit step without derivative/detail bookkeeping.
	const runoffStep = isAnalytic
		? hasDerivative
			? 'z = cmul(z, z) + c;'
			: 'z = cpowN(z) + c;'
		: 'z = cpowN(abs(z)) + c;';

	// Continue past the user's escape radius so the stripe average is taken against the
	// fixed stripe bailout — this keeps metric.y stripe data valid at every escape
	// radius while metric.x stays relative to the user's radius, letting the display
	// toggle stripe mode without re-running this pass.
	const stripeRunoff = `	int stripeSamples = detailSamples;
	float stripeMagSq = dot(z, z);
	for (int r = 0; r < STRIPE_RUNOFF_LIMIT; r++) {
		if (!isFiniteFloat(stripeMagSq) || stripeMagSq > STRIPE_AVERAGE_ESCAPE_RADIUS * STRIPE_AVERAGE_ESCAPE_RADIUS) {
			break;
		}
		${runoffStep}
		float runoffMagSq = dot(z, z);
		if (!isFiniteFloat(runoffMagSq)) break;
		stripeMagSq = runoffMagSq;
		previousStripeEwma = stripeEwma;
		stripeEwma = mix(stripeEwma, stripeAverageAddend(z), STRIPE_EWMA_ALPHA);
		stripeSamples += 1;
	}`;

	const iterateFunction = isAnalytic
		? `vec4 iterate(vec2 coord, float pixelRadius) {
${
	isMandelbrot && isQuadratic
		? `	if (inMandelbrotInterior(coord)) {
		return interiorMetric(INTERIOR_FLAT);
	}
`
		: ''
}	vec2 z = ${isJulia ? 'coord' : 'vec2(0.0)'};
${hasDerivative ? `	vec2 dz = ${isJulia ? 'vec2(1.0, 0.0)' : 'vec2(0.0)'};\n` : ''}	vec2 c = ${isJulia ? 'vec2(u_cReal, u_cImaginary)' : 'coord'};
${hasDerivative ? '' : '	float detailTotal = 0.0;\n'}	float stripeEwma = 0.5;
	float previousStripeEwma = 0.5;
	int detailSamples = 0;
	float minMagSq = 1.0e30;
	vec2 tortoise = vec2(1.0e30);
	int nextTortoiseUpdate = 8;
${hasDerivative ? '	float logViewRadius = log(2.0) - log(max(u_zoom, 1e-30));\n' : ''}	bool escaped = false;
	float escapeIters = 0.0;
	vec2 escapeZ = vec2(0.0);
${hasDerivative ? '	vec2 escapeDz = vec2(0.0);\n' : ''}	for (int i = 0; i < u_iterations; i++) {
		${analyticStep}
		float mag = length(z);
		minMagSq = min(minMagSq, mag * mag);
${hasDerivative ? '' : '		detailTotal += orbitDetailValue(z);\n'}		previousStripeEwma = stripeEwma;
		stripeEwma = mix(stripeEwma, stripeAverageAddend(z), STRIPE_EWMA_ALPHA);
		detailSamples += 1;
		if (mag > u_escapeRadius) {
			escaped = true;
			escapeIters = smoothEscape(i, mag);
			escapeZ = z;
${hasDerivative ? '			escapeDz = dz;\n' : ''}			break;
		}
${glslCycleCheck(interiorArg)}
	}
	if (!escaped) {
		return interiorMetric(${interiorArg});
	}
${stripeRunoff}
	${escapedReturn}
}`
		: `vec4 iterate(vec2 coord, float pixelRadius) {
${isShip ? '	coord = vec2(1.0, -1.0) * coord;\n' : ''}	vec2 z = ${isShip ? 'vec2(0.0)' : 'coord'};
	vec2 c = ${isShip ? 'coord' : 'vec2(u_cReal, u_cImaginary)'};
	float detailTotal = 0.0;
	float stripeEwma = 0.5;
	float previousStripeEwma = 0.5;
	int detailSamples = 0;
	float minMagSq = 1.0e30;
	vec2 tortoise = vec2(1.0e30);
	int nextTortoiseUpdate = 8;
	bool escaped = false;
	float escapeIters = 0.0;
	for (int i = 0; i < u_iterations; i++) {
		z = cpowN(abs(z)) + c;
		float mag = length(z);
		minMagSq = min(minMagSq, mag * mag);
		detailTotal += orbitDetailValue(z);
		previousStripeEwma = stripeEwma;
		stripeEwma = mix(stripeEwma, stripeAverageAddend(z), STRIPE_EWMA_ALPHA);
		detailSamples += 1;
		if (mag > u_escapeRadius) {
			escaped = true;
			escapeIters = smoothEscape(i, mag);
			break;
		}
${glslCycleCheck('minMagSq')}
	}
	if (!escaped) {
		return interiorMetric(minMagSq);
	}
${stripeRunoff}
	${escapedReturn}
}`;

	return `#version 300 es
precision highp float;

#define N_COLORS ${N_COLORS}
#define FRACTAL_TYPE ${fractalType}
#define EXPONENT ${exponent}

uniform vec2 u_resolution;
uniform vec2 u_center;
uniform float u_zoom;
uniform float u_cReal;
uniform float u_cImaginary;
uniform int u_iterations;
uniform float u_escapeRadius;
uniform float u_logEscapeRadius;

out vec4 FragColor;
${GLSL_PACK_CONSTANTS}${GLSL_IS_FINITE}${GLSL_METRIC_SHARED}
${glslPowerFunction(exponent)}
${
	isMandelbrot && isQuadratic
		? `
bool inMandelbrotInterior(vec2 c) {
	// Main cardioid: |1 - sqrt(1 - 4c)| < 1 ⇔ q(q + (c.x - 1/4)) < c.y^2 / 4
	// Period-2 bulb: (c.x + 1)^2 + c.y^2 < 1/16
	float xq = c.x - 0.25;
	float q = xq * xq + c.y * c.y;
	if (q * (q + xq) < 0.25 * c.y * c.y) return true;
	float xp = c.x + 1.0;
	if (xp * xp + c.y * c.y < 0.0625) return true;
	return false;
}
`
		: ''
}
${iterateFunction}

void main() {
	vec2 pixelScale = u_resolution / min(u_resolution.x, u_resolution.y);
	vec2 normalizedCoords = (gl_FragCoord.xy / u_resolution * 2.0 - 1.0) * pixelScale;
	float pixelRadius = 1.0 / max(u_resolution.x, u_resolution.y);

	vec2 centeredCoords = (normalizedCoords / u_zoom + u_center) * 2.0;

	FragColor = iterate(centeredCoords, pixelRadius);
}
`;
}
