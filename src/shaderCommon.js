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

// Mixing factor of the stripe exponentially-weighted moving average (effective window
// ~2/alpha samples). A plain all-orbit average washes to its mean at deep-zoom iteration
// counts (variance ~ 1/N) and the stripe field goes flat; the EWMA keeps stripe contrast
// depth-independent and weights the escape-vicinity samples where the visible structure
// lives. Shared with deepZoomTables so the reference prefix EWMA (used to carry the
// running value across BLA chunk skips) uses the same recurrence.
export const STRIPE_EWMA_ALPHA = 0.1;

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
// the host shader's u_escapeRadius / u_logEscapeRadius uniforms.
//
// Metric layout (consumed by the display shader's getPaletteColor):
//   .x = smooth iteration count (always relative to the user's escape radius)
//   .y = stripe palette-index offset (always computed; the display gates it on its own
//        u_stripeAverage uniform, so toggling stripe never re-runs the iteration pass)
//   .z = packed visual data (detail brightness + optional slope normal angle)
//   .w = coverage; the display forces this to 1 in stripe mode so the stripe pattern
//        paints the interior too.
export const GLSL_METRIC_SHARED = `
const float STRIPE_AVERAGE_DENSITY = 8.0;
// One palette wrap per unit of stripe variation, so the scale matches the palette size.
const float STRIPE_AVERAGE_COLOR_SCALE = float(N_COLORS);
const float STRIPE_AVERAGE_ESCAPE_RADIUS = 64.0;
const float STRIPE_EWMA_ALPHA = ${STRIPE_EWMA_ALPHA};
// Cap on the post-escape stripe runoff. From the default escape radius the orbit
// reaches the stripe radius in 2-4 squarings; the cap only binds for sub-1 escape
// radii, where orbits can linger — a partial average still stripes acceptably there.
const int STRIPE_RUNOFF_LIMIT = 32;
const float NO_NORMAL_ANGLE = -1.0;

vec2 cmul(vec2 a, vec2 b) {
	return vec2(a.x * b.x - a.y * b.y, a.x * b.y + b.x * a.y);
}

float smoothEscape(int iteration, float mag) {
	float logMag = log(mag);
	// Escape radii below 1 have negative logs. The guard must preserve that sign:
	// clamping the denominator to +1e-6 (old behavior) flipped logRatio negative and
	// made nu NaN, blacking out every escaped pixel at escape radii < 1. With both
	// logs negative the ratio is positive again and the formula still smooths.
	float safeLogEscape = abs(u_logEscapeRadius) < 1e-6 ? 1e-6 : u_logEscapeRadius;
	float logRatio = logMag / safeLogEscape;
	// |z| can overshoot past 1 when the radius is < 1, where the ratio goes negative
	// and the formula has no meaning; clamp instead of returning NaN.
	float nu = log2(max(logRatio, 1e-6));
	return float(iteration) + 1.0 - clamp(nu, -1.0, 2.0);
}

float stripeAverageAddend(vec2 z) {
	return 0.5 + 0.5 * sin(STRIPE_AVERAGE_DENSITY * atan(z.y, z.x));
}

// Continuous stripe coloring from the EWMA of the orbit addends, blended against the
// pre-escape EWMA via the same fractional-iteration factor smoothEscape uses, so the
// result is continuous across the escape boundary. Returns a palette-index offset.
//
// Always computed and packed into metric.y — the display pass decides whether stripe
// mode uses it, so toggling stripe never re-runs the iteration pass. The EWMA and
// stripeMagnitudeSq come from the stripe runoff (the orbit continued past the user's
// escape radius to STRIPE_AVERAGE_ESCAPE_RADIUS so the value stays smooth).
float stripePaletteOffset(float stripeEwma, float previousStripeEwma, int stripeSamples, float stripeMagnitudeSq) {
	if (stripeSamples <= 0) return 0.0;
	if (stripeSamples == 1 || !isFiniteFloat(stripeMagnitudeSq) || stripeMagnitudeSq <= 1.000001) {
		return stripeEwma * STRIPE_AVERAGE_COLOR_SCALE;
	}
	float bailout = STRIPE_AVERAGE_ESCAPE_RADIUS;
	float frac = 1.0 + log2(log(bailout * bailout) / max(log(stripeMagnitudeSq), 1e-6));
	float mixedEwma = mix(previousStripeEwma, stripeEwma, clamp(frac, 0.0, 1.0));
	return mixedEwma * STRIPE_AVERAGE_COLOR_SCALE;
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

// Stable metric for non-escaping (interior) pixels. Coverage 0 routes the display to
// insideColor; when the display has stripe mode on it forces coverage to 1 itself and
// samples the palette at offset 0 so the interior renders a single, zoom-independent
// color instead of drifting as the orbit sum keeps accumulating.
//
// minMagSq is the squared minimum |z| along the orbit (excluding the seed) and drives a
// subtle atom-domain brightness on the interior: orbits passing near 0 glow, so nuclei
// and their domains read as structure instead of a flat fill. Pass INTERIOR_FLAT for the
// legacy flat interior — quadratic Mandelbrot uses it everywhere because its
// cardioid/bulb early-out never iterates, and shading only the iterated pixels would
// draw a seam along the early-out boundary.
const float INTERIOR_FLAT = -1.0;

vec4 interiorMetric(float minMagSq) {
	float brightness = minMagSq < 0.0 ? 1.0 : 0.6 + exp(-4.0 * sqrt(max(minMagSq, 0.0)));
	return vec4(0.0, 0.0, packVisualMetric(brightness, NO_NORMAL_ANGLE), 0.0);
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

// The detail-weighting inputs (z, dz, detailSamples) are snapshotted at the user's
// escape radius; the stripe inputs continue through the stripe runoff to
// STRIPE_AVERAGE_ESCAPE_RADIUS, so they arrive as separate arguments.
vec4 buildDistanceMetric(
	float smoothIters,
	vec2 z,
	vec2 dz,
	float dzLogOffset,
	float stripeEwma,
	float previousStripeEwma,
	int stripeSamples,
	float stripeMagnitudeSq,
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
	float stripeOffset = stripePaletteOffset(stripeEwma, previousStripeEwma, stripeSamples, stripeMagnitudeSq);
	return vec4(smoothIters, stripeOffset, packVisualMetric(detailBrightness, normalAngle), coverage);
}

float orbitDetailValue(vec2 z) {
	return 1.0 / (1.0 + dot(z, z));
}

// Metric for escaped pixels of the non-quadratic / folded formulas, which don't carry a
// derivative for the distance estimate. Detail brightness comes from the orbit average.
vec4 buildMetric(
	float smoothIters,
	float detailTotal,
	int detailSamples,
	float stripeEwma,
	float previousStripeEwma,
	int stripeSamples,
	float stripeMagnitudeSq,
	float coverage
) {
	float detailAverage = detailSamples > 0 ? detailTotal / float(detailSamples) : 0.5;
	float detailWeight = coverage < 0.5 ? 1.0 : smoothstep(3.0, 24.0, float(detailSamples));
	float detailBrightness = mix(1.0, mix(0.82, 1.16, detailAverage), detailWeight);
	float stripeOffset = stripePaletteOffset(stripeEwma, previousStripeEwma, stripeSamples, stripeMagnitudeSq);
	return vec4(smoothIters, stripeOffset, packVisualMetric(detailBrightness, NO_NORMAL_ANGLE), coverage);
}
`;
