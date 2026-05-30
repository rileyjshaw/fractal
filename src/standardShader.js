import { GLSL_IS_FINITE, GLSL_METRIC_SHARED, GLSL_PACK_CONSTANTS, N_COLORS } from './shaderCommon.js';

export function generateStandardShader() {
	return `#version 300 es
precision highp float;

// Standard iteration pass: outputs the per-pixel metric (smoothIters, stripeOffset,
// packed visual data, coverage) to an FBO. The downstream display shader
// (deepDisplayShader.js) reads this metric and applies the palette/lighting, so palette
// and lighting changes only re-run the cheap display pass.
#define N_COLORS ${N_COLORS}

uniform vec2 u_resolution;
uniform vec2 u_center;
uniform float u_zoom;
uniform int u_fractalType;
uniform int u_exponent;
uniform float u_cReal;
uniform float u_cImaginary;
uniform int u_iterations;
uniform float u_escapeRadius;
uniform float u_logEscapeRadius;
uniform int u_stripeAverage;

out vec4 FragColor;
${GLSL_PACK_CONSTANTS}${GLSL_IS_FINITE}${GLSL_METRIC_SHARED}
vec2 cpow(vec2 z, int n) {
	vec2 sum = z;
	for (int i = 0; i < n - 1; i++) {
		sum = cmul(sum, z);
	}
	return sum;
}

float orbitDetailValue(vec2 z) {
	return 1.0 / (1.0 + dot(z, z));
}

// Metric for escaped pixels of the non-quadratic / folded formulas, which don't carry a
// derivative for the distance estimate. Detail brightness comes from the orbit average.
vec4 buildMetric(
	float smoothIters,
	float detailTotal,
	float stripeTotal,
	float lastStripeValue,
	int detailSamples,
	float magnitudeSq,
	float coverage
) {
	float detailAverage = detailSamples > 0 ? detailTotal / float(detailSamples) : 0.5;
	float detailWeight = coverage < 0.5 ? 1.0 : smoothstep(3.0, 24.0, float(detailSamples));
	float detailBrightness = mix(1.0, mix(0.82, 1.16, detailAverage), detailWeight);
	float stripeOffset = stripePaletteOffset(stripeTotal, lastStripeValue, detailSamples, magnitudeSq);
	float finalCoverage = max(coverage, float(u_stripeAverage));
	return vec4(smoothIters, stripeOffset, packVisualMetric(detailBrightness, NO_NORMAL_ANGLE), finalCoverage);
}

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

vec4 iterateJulia(vec2 coord, vec2 c, float pixelRadius) {
	vec2 z = coord;
	vec2 dz = vec2(1.0, 0.0);
	float detailTotal = 0.0;
	float stripeTotal = 0.0;
	float lastStripeValue = 0.5;
	int detailSamples = 0;
	float logViewRadius = log(2.0) - log(max(u_zoom, 1e-30));
	float escapeRadius = u_stripeAverage == 1 ? max(u_escapeRadius, STRIPE_AVERAGE_ESCAPE_RADIUS) : u_escapeRadius;
	for (int i = 0; i < u_iterations; i++) {
		vec2 previousZ = z;
		if (u_exponent == 2) {
			dz = cmul(vec2(2.0 * previousZ.x, 2.0 * previousZ.y), dz);
			z = cmul(previousZ, previousZ) + c;
		} else {
			z = cpow(previousZ, u_exponent) + c;
		}
		float mag = length(z);
		detailTotal += orbitDetailValue(z);
		lastStripeValue = stripeAverageAddend(z);
		stripeTotal += lastStripeValue;
		detailSamples += 1;
		if (mag > escapeRadius) {
			if (u_exponent == 2) {
				return buildDistanceMetric(
					smoothEscape(i, mag),
					z,
					dz,
					0.0,
					stripeTotal,
					lastStripeValue,
					detailSamples,
					logViewRadius,
					pixelRadius
				);
			}
			return buildMetric(
				smoothEscape(i, mag),
				detailTotal,
				stripeTotal,
				lastStripeValue,
				detailSamples,
				mag * mag,
				1.0
			);
		}
	}
	return interiorMetric();
}

vec4 iterateMandelbrot(vec2 coord, float pixelRadius) {
	if (u_exponent == 2 && inMandelbrotInterior(coord)) {
		return interiorMetric();
	}
	vec2 z = vec2(0.0);
	vec2 dz = vec2(0.0);
	float detailTotal = 0.0;
	float stripeTotal = 0.0;
	float lastStripeValue = 0.5;
	int detailSamples = 0;
	float logViewRadius = log(2.0) - log(max(u_zoom, 1e-30));
	float escapeRadius = u_stripeAverage == 1 ? max(u_escapeRadius, STRIPE_AVERAGE_ESCAPE_RADIUS) : u_escapeRadius;
	for (int i = 0; i < u_iterations; i++) {
		vec2 previousZ = z;
		if (u_exponent == 2) {
			dz = cmul(vec2(2.0 * previousZ.x, 2.0 * previousZ.y), dz) + vec2(1.0, 0.0);
			z = cmul(previousZ, previousZ) + coord;
		} else {
			z = cpow(previousZ, u_exponent) + coord;
		}
		float mag = length(z);
		detailTotal += orbitDetailValue(z);
		lastStripeValue = stripeAverageAddend(z);
		stripeTotal += lastStripeValue;
		detailSamples += 1;
		if (mag > escapeRadius) {
			if (u_exponent == 2) {
				return buildDistanceMetric(
					smoothEscape(i, mag),
					z,
					dz,
					0.0,
					stripeTotal,
					lastStripeValue,
					detailSamples,
					logViewRadius,
					pixelRadius
				);
			}
			return buildMetric(
				smoothEscape(i, mag),
				detailTotal,
				stripeTotal,
				lastStripeValue,
				detailSamples,
				mag * mag,
				1.0
			);
		}
	}
	return interiorMetric();
}

vec4 iterateBurningShip(vec2 coord) {
	coord = vec2(1.0, -1.0) * coord;
	vec2 z = vec2(0.0);
	float detailTotal = 0.0;
	float stripeTotal = 0.0;
	float lastStripeValue = 0.5;
	int detailSamples = 0;
	float escapeRadius = u_stripeAverage == 1 ? max(u_escapeRadius, STRIPE_AVERAGE_ESCAPE_RADIUS) : u_escapeRadius;
	for (int i = 0; i < u_iterations; i++) {
		z = cpow(abs(z), u_exponent) + coord;
		float mag = length(z);
		detailTotal += orbitDetailValue(z);
		lastStripeValue = stripeAverageAddend(z);
		stripeTotal += lastStripeValue;
		detailSamples += 1;
		if (mag > escapeRadius) {
			return buildMetric(
				smoothEscape(i, mag),
				detailTotal,
				stripeTotal,
				lastStripeValue,
				detailSamples,
				mag * mag,
				1.0
			);
		}
	}
	return interiorMetric();
}

vec4 iterateMandala(vec2 coord, vec2 c) {
	vec2 z = coord;
	float detailTotal = 0.0;
	float stripeTotal = 0.0;
	float lastStripeValue = 0.5;
	int detailSamples = 0;
	float escapeRadius = u_stripeAverage == 1 ? max(u_escapeRadius, STRIPE_AVERAGE_ESCAPE_RADIUS) : u_escapeRadius;
	for (int i = 0; i < u_iterations; i++) {
		z = cpow(abs(z), u_exponent) + c;
		float mag = length(z);
		detailTotal += orbitDetailValue(z);
		lastStripeValue = stripeAverageAddend(z);
		stripeTotal += lastStripeValue;
		detailSamples += 1;
		if (mag > escapeRadius) {
			return buildMetric(
				smoothEscape(i, mag),
				detailTotal,
				stripeTotal,
				lastStripeValue,
				detailSamples,
				mag * mag,
				1.0
			);
		}
	}
	return interiorMetric();
}

void main() {
	vec2 pixelScale = u_resolution / min(u_resolution.x, u_resolution.y);
	vec2 normalizedCoords = (gl_FragCoord.xy / u_resolution * 2.0 - 1.0) * pixelScale;
	float pixelRadius = 1.0 / max(u_resolution.x, u_resolution.y);

	vec2 centeredCoords = (normalizedCoords / u_zoom + u_center) * 2.0;

	vec4 metric = vec4(0.0, 0.0, 1.0, 0.0);
	switch (u_fractalType) {
		case 0:
			metric = iterateJulia(centeredCoords, vec2(u_cReal, u_cImaginary), pixelRadius);
			break;
		case 1:
			metric = iterateMandelbrot(centeredCoords, pixelRadius);
			break;
		case 2:
			metric = iterateBurningShip(centeredCoords);
			break;
		case 3:
			metric = iterateMandala(centeredCoords, vec2(u_cReal, u_cImaginary));
			break;
	}

	FragColor = metric;
}
`;
}
