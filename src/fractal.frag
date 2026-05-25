#version 300 es
precision highp float;

// Iteration pass: outputs the per-pixel metric (smoothIters, stripeOffset,
// brightness, coverage) to an FBO. The downstream display shader
// (deepDisplayShader.js) reads this metric and applies the palette. Palette
// animation only re-runs the cheap display pass.
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
uniform int u_slopeShading;
uniform vec2 u_slopeLightDir;
uniform float u_slopeLightHeight;
uniform float u_slopeLightIntensity;
uniform int u_stripeAverage;

out vec4 FragColor;

const float STRIPE_AVERAGE_DENSITY = 8.0;
// Must match STRIPE_AVERAGE_COLOR_SCALE in deepDisplayShader.js (= N_COLORS there).
const float STRIPE_AVERAGE_COLOR_SCALE = 32.0;
const float STRIPE_AVERAGE_ESCAPE_RADIUS = 64.0;

vec2 cmul(vec2 a, vec2 b) {
	return vec2(a.x * b.x - a.y * b.y, a.x * b.y + b.x * a.y);
}

vec2 cpow(vec2 z, int n) {
	vec2 sum = z;
	for (int i = 0; i < n - 1; i++) {
		sum = cmul(sum, z);
	}
	return sum;
}

bool isFiniteFloat(float value) {
	// GLSL's isnan/isinf are unreliable under fast-math; check magnitude directly.
	return value == value && abs(value) < 3.0e38;
}

float smoothEscape(int iteration, float mag) {
	float logMag = log(mag);
	float logEscapeRadius =
		u_stripeAverage == 1
			? log(max(u_escapeRadius, STRIPE_AVERAGE_ESCAPE_RADIUS))
			: u_logEscapeRadius;
	float logRatio = logMag / max(logEscapeRadius, 1e-6);
	float nu = log2(logRatio);
	return float(iteration) + 1.0 - nu;
}

float orbitDetailValue(vec2 z) {
	return 1.0 / (1.0 + dot(z, z));
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

float computeSlopeBrightness(vec2 z, vec2 dz) {
	vec2 n = vec2(z.x * dz.x + z.y * dz.y, z.y * dz.x - z.x * dz.y);
	float len = length(n);
	if (!isFiniteFloat(len) || len < 1e-20) return 1.0;
	n /= len;
	float lightHeight = max(u_slopeLightHeight, 1e-3);
	float diffuse = (dot(n, normalize(u_slopeLightDir)) + lightHeight) / (1.0 + lightHeight);
	diffuse = clamp(diffuse, 0.0, 1.0);
	return max(0.0, mix(1.0, 0.45 + 0.85 * diffuse, u_slopeLightIntensity));
}

vec2 distanceEstimateMetrics(vec2 z, vec2 dz, float logViewRadius, float pixelRadius) {
	// Returns (boundarySignal, coverage):
	//   boundarySignal: wide [0, 1] ramp peaking at the set boundary, drives palette shifts.
	//   coverage: narrow sub-pixel ramp, 0 on boundary, 1 a couple pixels out, drives AA.
	float mag = length(z);
	float derivativeMag = length(dz);
	if (!isFiniteFloat(mag) || !isFiniteFloat(derivativeMag) || mag <= 1.0 || derivativeMag <= 1e-20) {
		return vec2(0.0, 1.0);
	}
	float logDistance = log(0.5 * mag * max(log(mag), 1e-6)) - log(derivativeMag);
	float screenDistance = exp(clamp(logDistance - logViewRadius, -30.0, 30.0));
	if (!isFiniteFloat(screenDistance)) return vec2(0.0, 1.0);
	float boundarySignal = clamp(1.0 - smoothstep(0.003, 0.12, screenDistance), 0.0, 1.0);
	float coverage = smoothstep(0.0, pixelRadius * 2.0, screenDistance);
	return vec2(boundarySignal, coverage);
}

// Metric layout (consumed by getPaletteColor):
//   .x = smooth iteration count
//   .y = palette-index offset (stripe contribution, 0 when stripe is off)
//   .z = brightness multiplier (detail + slope shading)
//   .w = coverage; stripe mode forces this to 1 so the stripe pattern paints
//        the M-set interior as well.
vec4 buildMetric(
	float smoothIters,
	float detailTotal,
	float stripeTotal,
	float lastStripeValue,
	int detailSamples,
	float magnitudeSq,
	float coverage,
	float slopeBrightness
) {
	float detailAverage = detailSamples > 0 ? detailTotal / float(detailSamples) : 0.5;
	float detailWeight = coverage < 0.5 ? 1.0 : smoothstep(3.0, 24.0, float(detailSamples));
	float detailBrightness = mix(1.0, mix(0.82, 1.16, detailAverage), detailWeight);
	float stripeOffset = stripePaletteOffset(stripeTotal, lastStripeValue, detailSamples, magnitudeSq);
	float finalCoverage = max(coverage, float(u_stripeAverage));
	return vec4(smoothIters, stripeOffset, detailBrightness * slopeBrightness, finalCoverage);
}

// Stable metric for non-escaping (interior) pixels. With stripe averaging off,
// coverage=0 routes the display to insideColor and the iteration count is unused.
// With stripe on, coverage is forced to 1 and the palette is sampled at offset 0
// so the interior renders a single, zoom-independent color instead of drifting as
// u_iterations grows and the orbit sum keeps accumulating.
vec4 interiorMetric() {
	return vec4(0.0, 0.0, 1.0, float(u_stripeAverage));
}

vec4 buildDistanceMetric(
	float smoothIters,
	vec2 z,
	vec2 dz,
	float stripeTotal,
	float lastStripeValue,
	int detailSamples,
	float logViewRadius,
	float pixelRadius
) {
	float detailWeight = smoothstep(4.0, 32.0, float(detailSamples));
	vec2 deMetrics = distanceEstimateMetrics(z, dz, logViewRadius, pixelRadius);
	float boundarySignal = deMetrics.x;
	float coverage = deMetrics.y;
	float slopeBrightness = u_slopeShading == 1 ? computeSlopeBrightness(z, dz) : 1.0;
	float detailBrightness = mix(1.0, 1.16, boundarySignal * detailWeight);
	float stripeOffset = stripePaletteOffset(stripeTotal, lastStripeValue, detailSamples, dot(z, z));
	float finalCoverage = max(coverage, float(u_stripeAverage));
	return vec4(smoothIters, stripeOffset, detailBrightness * slopeBrightness, finalCoverage);
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
				1.0,
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
				1.0,
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
				1.0,
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
				1.0,
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
