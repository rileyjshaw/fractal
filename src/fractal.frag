#version 300 es
precision highp float;

#define N_COLORS 32

uniform vec2 u_resolution;
uniform float u_paletteFrame;
uniform vec2 u_center;
uniform float u_zoom;
uniform int u_fractalType;
uniform int u_exponent;
uniform float u_cReal;
uniform float u_cImaginary;
uniform int u_iterations;
uniform vec3 u_colors[N_COLORS];
uniform int u_transitionSmoothing;
uniform float u_escapeRadius;
uniform float u_logEscapeRadius;
uniform float u_colorScale;
uniform int u_slopeShading;

out vec4 FragColor;

const vec2 SLOPE_LIGHT_DIR = vec2(-0.7071, 0.7071);
const float SLOPE_LIGHT_HEIGHT = 1.5;

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
	float logRatio = logMag / max(u_logEscapeRadius, 1e-6);
	float nu = log2(logRatio);
	return float(iteration) + float(u_transitionSmoothing) * (1.0 - nu);
}

float orbitDetailValue(vec2 z) {
	return 1.0 / (1.0 + dot(z, z));
}

float computeSlopeBrightness(vec2 z, vec2 dz) {
	vec2 n = vec2(z.x * dz.x + z.y * dz.y, z.y * dz.x - z.x * dz.y);
	float len = length(n);
	if (!isFiniteFloat(len) || len < 1e-20) return 1.0;
	n /= len;
	float diffuse = (dot(n, SLOPE_LIGHT_DIR) + SLOPE_LIGHT_HEIGHT) / (1.0 + SLOPE_LIGHT_HEIGHT);
	diffuse = clamp(diffuse, 0.0, 1.0);
	return 0.45 + 0.85 * diffuse;
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

vec4 buildMetric(float smoothIters, float detailTotal, int detailSamples, float coverage, float slopeBrightness) {
	float detailAverage = detailSamples > 0 ? detailTotal / float(detailSamples) : 0.5;
	float detailWeight = coverage < 0.5 ? 1.0 : smoothstep(3.0, 24.0, float(detailSamples));
	float weightedDetailOffset = (detailAverage - 0.5) * detailWeight;
	float detailBrightness = mix(1.0, mix(0.82, 1.16, 0.5 + weightedDetailOffset), detailWeight);
	return vec4(smoothIters, weightedDetailOffset, detailBrightness * slopeBrightness, coverage);
}

vec4 buildDistanceMetric(
	float smoothIters,
	vec2 z,
	vec2 dz,
	int detailSamples,
	float logViewRadius,
	float pixelRadius
) {
	float detailWeight = smoothstep(4.0, 32.0, float(detailSamples));
	vec2 deMetrics = distanceEstimateMetrics(z, dz, logViewRadius, pixelRadius);
	float boundarySignal = deMetrics.x;
	float coverage = deMetrics.y;
	float slopeBrightness = u_slopeShading == 1 ? computeSlopeBrightness(z, dz) : 1.0;
	float signedDetail = 0.5 * boundarySignal * detailWeight;
	float detailBrightness = mix(1.0, mix(0.82, 1.16, 0.5 + signedDetail), detailWeight);
	return vec4(smoothIters, signedDetail, detailBrightness * slopeBrightness, coverage);
}

vec3 getPaletteColor(vec4 metric) {
	float signedDetail = metric.y;
	float colorIdx = metric.x * u_colorScale + signedDetail * 1.4 + u_paletteFrame;
	float wrappedIdx = mod(floor(colorIdx), float(N_COLORS));
	float t = fract(colorIdx);
	int fromIdx = int(wrappedIdx);
	int toIdx = (fromIdx + 1) % N_COLORS;

	vec3 outsideColor = mix(u_colors[fromIdx], u_colors[toIdx], t) * metric.z;
	vec3 insideColor = mix(u_colors[0], u_colors[1], 0.5 + signedDetail) * 0.18;
	return clamp(mix(insideColor, outsideColor, metric.w), 0.0, 1.0);
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
	int detailSamples = 0;
	float logViewRadius = log(2.0) - log(max(u_zoom, 1e-30));
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
		detailSamples += 1;
		if (mag > u_escapeRadius) {
			if (u_exponent == 2) {
				return buildDistanceMetric(smoothEscape(i, mag), z, dz, detailSamples, logViewRadius, pixelRadius);
			}
			return buildMetric(smoothEscape(i, mag), detailTotal, detailSamples, 1.0, 1.0);
		}
	}
	return buildMetric(float(u_iterations), detailTotal, detailSamples, 0.0, 1.0);
}

vec4 iterateMandelbrot(vec2 coord, float pixelRadius) {
	if (u_exponent == 2 && inMandelbrotInterior(coord)) {
		return buildMetric(float(u_iterations), 0.0, 0, 0.0, 1.0);
	}
	vec2 z = vec2(0.0);
	vec2 dz = vec2(0.0);
	float detailTotal = 0.0;
	int detailSamples = 0;
	float logViewRadius = log(2.0) - log(max(u_zoom, 1e-30));
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
		detailSamples += 1;
		if (mag > u_escapeRadius) {
			if (u_exponent == 2) {
				return buildDistanceMetric(smoothEscape(i, mag), z, dz, detailSamples, logViewRadius, pixelRadius);
			}
			return buildMetric(smoothEscape(i, mag), detailTotal, detailSamples, 1.0, 1.0);
		}
	}
	return buildMetric(float(u_iterations), detailTotal, detailSamples, 0.0, 1.0);
}

vec4 iterateBurningShip(vec2 coord) {
	coord = vec2(1.0, -1.0) * coord;
	vec2 z = vec2(0.0);
	float detailTotal = 0.0;
	int detailSamples = 0;
	for (int i = 0; i < u_iterations; i++) {
		z = cpow(abs(z), u_exponent) + coord;
		float mag = length(z);
		detailTotal += orbitDetailValue(z);
		detailSamples += 1;
		if (mag > u_escapeRadius) {
			return buildMetric(smoothEscape(i, mag), detailTotal, detailSamples, 1.0, 1.0);
		}
	}
	return buildMetric(float(u_iterations), detailTotal, detailSamples, 0.0, 1.0);
}

vec4 iterateMandala(vec2 coord, vec2 c) {
	vec2 z = coord;
	float detailTotal = 0.0;
	int detailSamples = 0;
	for (int i = 0; i < u_iterations; i++) {
		z = cpow(abs(z), u_exponent) + c;
		float mag = length(z);
		detailTotal += orbitDetailValue(z);
		detailSamples += 1;
		if (mag > u_escapeRadius) {
			return buildMetric(smoothEscape(i, mag), detailTotal, detailSamples, 1.0, 1.0);
		}
	}
	return buildMetric(float(u_iterations), detailTotal, detailSamples, 0.0, 1.0);
}

void main() {
	vec2 pixelScale = u_resolution / min(u_resolution.x, u_resolution.y);
	vec2 normalizedCoords = (gl_FragCoord.xy / u_resolution * 2.0 - 1.0) * pixelScale;
	float pixelRadius = 1.0 / max(u_resolution.x, u_resolution.y);

	vec2 centeredCoords = (normalizedCoords / u_zoom + u_center) * 2.0;

	vec4 metric = vec4(float(u_iterations), 0.0, 1.0, 0.0);
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

	FragColor = vec4(getPaletteColor(metric), 1.0);
}
