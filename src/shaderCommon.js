// Single source of truth for GLSL shared across the three fragment shaders.
//
// The standard (standardShader.js) and perturbation (perturbationShader.js) iteration
// passes PACK a per-pixel metric into an FBO; the display pass (deepDisplayShader.js)
// UNPACKS it and applies the palette/lighting. The packing format (METRIC_PACK_* + TAU)
// and the shared coloring math therefore have to agree across all three shaders, so they
// live here as raw GLSL strings spliced into each shader template.
//
// (These shaders are generated as JS template strings rather than `.frag`/`.glsl` files —
// the perturbation shader needs JS constants such as ORBIT_TEXTURE_SIZE injected at build
// time — so sharing happens through JS imports rather than vite-plugin-glsl `#include`.)

// Palette size. Used JS-side for the palette texture/array and injected into every shader
// as `#define N_COLORS` so the stripe color scale and the display palette lookup stay in
// sync without three hand-synced copies of the number.
export const N_COLORS = 32;

// Metric-packing constants + TAU. Shared by all three shaders (the two iteration passes
// pack, the display pass unpacks), so they must agree everywhere.
export const GLSL_PACK_CONSTANTS = `
const float TAU = 6.283185307179586;
const float METRIC_PACK_COMPONENT_SCALE = 4096.0;
const float METRIC_PACK_DETAIL_SCALE = 1024.0;
const float METRIC_PACK_NORMAL_BINS = 4094.0;
const float METRIC_PACK_NORMAL_SENTINEL = 4095.0;
`;

// GLSL's isnan/isinf are unreliable under fast-math, so test magnitude directly. Used by
// all three shaders.
export const GLSL_IS_FINITE = `
bool isFiniteFloat(float value) {
	return value == value && abs(value) < 3.0e38;
}
`;

// Coloring + metric-building math shared by the two iteration passes (standard +
// perturbation). Depends on GLSL_PACK_CONSTANTS, GLSL_IS_FINITE, the N_COLORS define, and
// the host shader's u_stripeAverage / u_escapeRadius / u_logEscapeRadius uniforms.
//
// Metric layout (consumed by the display shader's getPaletteColor):
//   .x = smooth iteration count
//   .y = palette-index offset (stripe contribution, 0 when stripe is off)
//   .z = packed visual data (detail brightness + optional slope normal angle)
//   .w = coverage; stripe mode forces this to 1 so the stripe pattern paints the interior too.
export const GLSL_METRIC_SHARED = `
const float STRIPE_AVERAGE_DENSITY = 8.0;
// One palette wrap per unit of stripe variation, so the scale matches the palette size.
const float STRIPE_AVERAGE_COLOR_SCALE = float(N_COLORS);
const float STRIPE_AVERAGE_ESCAPE_RADIUS = 64.0;
const float NO_NORMAL_ANGLE = -1.0;

vec2 cmul(vec2 a, vec2 b) {
	return vec2(a.x * b.x - a.y * b.y, a.x * b.y + b.x * a.y);
}

float smoothEscape(int iteration, float mag) {
	float logMag = log(mag);
	float logEscapeRadius =
		u_stripeAverage == 1 ? log(max(u_escapeRadius, STRIPE_AVERAGE_ESCAPE_RADIUS)) : u_logEscapeRadius;
	float logRatio = logMag / max(logEscapeRadius, 1e-6);
	float nu = log2(logRatio);
	return float(iteration) + 1.0 - nu;
}

float stripeAverageAddend(vec2 z) {
	return 0.5 + 0.5 * sin(STRIPE_AVERAGE_DENSITY * atan(z.y, z.x));
}

// Continuous stripe average: average the addend across the orbit, then blend against the
// previous sample's average via the same fractional-iteration factor smoothEscape uses,
// so the result is continuous across the escape boundary. Returns a palette-index offset.
float stripePaletteOffset(float stripeTotal, float lastStripeValue, int stripeSamples, float magnitudeSq) {
	if (u_stripeAverage != 1 || stripeSamples <= 0) return 0.0;
	float stripeAverageValue = stripeTotal / float(stripeSamples);
	if (stripeSamples == 1 || !isFiniteFloat(magnitudeSq) || magnitudeSq <= 1.000001) {
		return stripeAverageValue * STRIPE_AVERAGE_COLOR_SCALE;
	}
	float previousAverage = (stripeTotal - lastStripeValue) / float(stripeSamples - 1);
	float bailout = max(u_escapeRadius, STRIPE_AVERAGE_ESCAPE_RADIUS);
	float frac = 1.0 + log2(log(bailout * bailout) / max(log(magnitudeSq), 1e-6));
	float mixedAverage = mix(previousAverage, stripeAverageValue, clamp(frac, 0.0, 1.0));
	return mixedAverage * STRIPE_AVERAGE_COLOR_SCALE;
}

float getSlopeNormalAngle(vec2 z, vec2 dz) {
	vec2 n = vec2(z.x * dz.x + z.y * dz.y, z.y * dz.x - z.x * dz.y);
	float len = length(n);
	if (!isFiniteFloat(len) || len < 1e-20) return NO_NORMAL_ANGLE;
	n /= len;
	float angle = atan(n.y, n.x);
	return angle < 0.0 ? angle + TAU : angle;
}

float packVisualMetric(float detailBrightness, float normalAngle) {
	float detailBin = floor(clamp(detailBrightness, 0.0, 3.999) * METRIC_PACK_DETAIL_SCALE + 0.5);
	float normalBin = METRIC_PACK_NORMAL_SENTINEL;
	if (normalAngle >= 0.0) {
		normalBin = floor(clamp(normalAngle / TAU, 0.0, 1.0) * METRIC_PACK_NORMAL_BINS + 0.5);
	}
	return detailBin * METRIC_PACK_COMPONENT_SCALE + normalBin;
}

// Stable metric for non-escaping (interior) pixels. With stripe averaging off, coverage=0
// routes the display to insideColor and the iteration count is unused. With stripe on,
// coverage is forced to 1 and the palette is sampled at offset 0 so the interior renders a
// single, zoom-independent color instead of drifting as the orbit sum keeps accumulating.
vec4 interiorMetric() {
	return vec4(0.0, 0.0, packVisualMetric(1.0, NO_NORMAL_ANGLE), float(u_stripeAverage));
}

// Milnor distance estimate -> (boundarySignal, coverage).
//   boundarySignal: wide [0, 1] ramp peaking at the set boundary; drives palette shifts.
//   coverage: sub-pixel AA ramp when pixelRadius > 0. Deep zoom passes pixelRadius < 0 to
//     force coverage = 1 (the DE distance falls far below a pixel there and would otherwise
//     blend the escaped region toward the interior colour).
// dz may be carried with a separate log-scale offset (deep zoom rescales the derivative to
// keep it in float range); pass dzLogOffset = 0 when dz is already the true derivative.
vec2 distanceEstimateMetrics(vec2 z, vec2 dz, float dzLogOffset, float logViewRadius, float pixelRadius) {
	float mag = length(z);
	float derivativeMag = length(dz);
	if (!isFiniteFloat(mag) || !isFiniteFloat(derivativeMag) || mag <= 1.0 || derivativeMag <= 1e-20) {
		return vec2(0.0, 1.0);
	}
	float logDistance = log(0.5 * mag * max(log(mag), 1e-6)) - (log(derivativeMag) + dzLogOffset);
	float screenDistance = exp(clamp(logDistance - logViewRadius, -30.0, 30.0));
	if (!isFiniteFloat(screenDistance)) return vec2(0.0, 1.0);
	float boundarySignal = clamp(1.0 - smoothstep(0.003, 0.12, screenDistance), 0.0, 1.0);
	float coverage = pixelRadius > 0.0 ? smoothstep(0.0, pixelRadius * 2.0, screenDistance) : 1.0;
	return vec2(boundarySignal, coverage);
}

vec4 buildDistanceMetric(
	float smoothIters,
	vec2 z,
	vec2 dz,
	float dzLogOffset,
	float stripeTotal,
	float lastStripeValue,
	int detailSamples,
	float logViewRadius,
	float pixelRadius
) {
	float detailWeight = smoothstep(4.0, 32.0, float(detailSamples));
	vec2 deMetrics = distanceEstimateMetrics(z, dz, dzLogOffset, logViewRadius, pixelRadius);
	float boundarySignal = deMetrics.x;
	float coverage = deMetrics.y;
	float detailBrightness = mix(1.0, 1.16, boundarySignal * detailWeight);
	float normalAngle = getSlopeNormalAngle(z, dz);
	float stripeOffset = stripePaletteOffset(stripeTotal, lastStripeValue, detailSamples, dot(z, z));
	float finalCoverage = max(coverage, float(u_stripeAverage));
	return vec4(smoothIters, stripeOffset, packVisualMetric(detailBrightness, normalAngle), finalCoverage);
}
`;
