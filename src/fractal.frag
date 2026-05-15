#version 300 es
precision highp float;

#define N_COLORS (32)
#define MAX_ITERATIONS (24576)

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

out vec4 FragColor;

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
	return !isnan(value) && !isinf(value);
}

float smoothEscape(int iteration, float mag) {
	float logMag = log(mag);
	float logRatio = logMag / max(u_logEscapeRadius, 1e-6);
	float nu = log(logRatio) / log(2.0);
	return float(iteration) + float(u_transitionSmoothing) * (1.0 - nu);
}

float orbitDetailValue(vec2 z) {
	return 1.0 / (1.0 + dot(z, z));
}

vec4 buildMetric(float smoothIters, float detailTotal, int detailSamples, float escaped) {
	float detailAverage = detailSamples > 0 ? detailTotal / float(detailSamples) : 0.5;
	float detailWeight = escaped > 0.5 ? smoothstep(3.0, 24.0, float(detailSamples)) : 1.0;
	return vec4(smoothIters, mix(0.5, detailAverage, detailWeight), detailWeight, escaped);
}

float distanceEstimateDetail(vec2 z, vec2 dz, float logViewRadius) {
	float mag = length(z);
	float derivativeMag = length(dz);
	if (!isFiniteFloat(mag) || !isFiniteFloat(derivativeMag) || mag <= 1.0 || derivativeMag <= 1e-20) {
		return 0.0;
	}

	float logDistance = log(0.5 * mag * max(log(mag), 1e-6)) - log(derivativeMag);
	float screenDistance = exp(clamp(logDistance - logViewRadius, -30.0, 30.0));
	if (!isFiniteFloat(screenDistance)) {
		return 0.0;
	}

	return clamp(1.0 - smoothstep(0.003, 0.12, screenDistance), 0.0, 1.0);
}

vec4 buildDistanceMetric(float smoothIters, vec2 z, vec2 dz, int detailSamples, float logViewRadius) {
	float detail = distanceEstimateDetail(z, dz, logViewRadius);
	float detailWeight = smoothstep(4.0, 32.0, float(detailSamples));
	return vec4(smoothIters, 0.5 + 0.5 * detail, detailWeight, 1.0);
}

vec3 getPaletteColor(vec4 metric) {
	float detail = (metric.y - 0.5) * metric.z;
	float colorIdx = metric.x * u_colorScale + detail * 1.4 + u_paletteFrame;
	float wrappedIdx = mod(floor(colorIdx), float(N_COLORS));
	float t = fract(colorIdx);
	int fromIdx = int(wrappedIdx);
	int toIdx = (fromIdx + 1) % N_COLORS;

	vec3 color = mix(u_colors[fromIdx], u_colors[toIdx], t);
	color *= mix(1.0, mix(0.82, 1.16, metric.y), metric.z);
	if (metric.w < 0.5) {
		color = mix(u_colors[0], u_colors[1], metric.y) * 0.18;
	}
	return clamp(color, 0.0, 1.0);
}

vec4 iterateJulia(vec2 coord, vec2 c) {
	vec2 z = coord;
	vec2 dz = vec2(1.0, 0.0);
	float detailTotal = 0.0;
	int detailSamples = 0;
	float logViewRadius = log(2.0) - log(max(u_zoom, 1e-30));
	for (int i = 0; i < MAX_ITERATIONS; i++) {
		if (i >= u_iterations) break;
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
				return buildDistanceMetric(smoothEscape(i, mag), z, dz, detailSamples, logViewRadius);
			}
			return buildMetric(smoothEscape(i, mag), detailTotal, detailSamples, 1.0);
		}
	}
	return buildMetric(float(u_iterations), detailTotal, detailSamples, 0.0);
}

vec4 iterateMandelbrot(vec2 coord) {
	vec2 z = vec2(0.0);
	vec2 dz = vec2(0.0);
	float detailTotal = 0.0;
	int detailSamples = 0;
	float logViewRadius = log(2.0) - log(max(u_zoom, 1e-30));
	for (int i = 0; i < MAX_ITERATIONS; i++) {
		if (i >= u_iterations) break;
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
				return buildDistanceMetric(smoothEscape(i, mag), z, dz, detailSamples, logViewRadius);
			}
			return buildMetric(smoothEscape(i, mag), detailTotal, detailSamples, 1.0);
		}
	}
	return buildMetric(float(u_iterations), detailTotal, detailSamples, 0.0);
}

vec4 iterateBurningShip(vec2 coord) {
	coord = vec2(1.0, -1.0) * coord;
	vec2 z = vec2(0.0);
	float detailTotal = 0.0;
	int detailSamples = 0;
	for (int i = 0; i < MAX_ITERATIONS; i++) {
		if (i >= u_iterations) break;
		z = cpow(abs(z), u_exponent) + coord;
		float mag = length(z);
		detailTotal += orbitDetailValue(z);
		detailSamples += 1;
		if (mag > u_escapeRadius) {
			return buildMetric(smoothEscape(i, mag), detailTotal, detailSamples, 1.0);
		}
	}
	return buildMetric(float(u_iterations), detailTotal, detailSamples, 0.0);
}

vec4 iterateMandala(vec2 coord, vec2 c) {
	vec2 z = coord;
	float detailTotal = 0.0;
	int detailSamples = 0;
	for (int i = 0; i < MAX_ITERATIONS; i++) {
		if (i >= u_iterations) break;
		z = cpow(abs(z), u_exponent) + c;
		float mag = length(z);
		detailTotal += orbitDetailValue(z);
		detailSamples += 1;
		if (mag > u_escapeRadius) {
			return buildMetric(smoothEscape(i, mag), detailTotal, detailSamples, 1.0);
		}
	}
	return buildMetric(float(u_iterations), detailTotal, detailSamples, 0.0);
}

void main() {
	float aspectRatio = u_resolution.x / u_resolution.y;
	vec2 normalizedCoords = gl_FragCoord.xy / u_resolution * 2.0 - 1.0;

	if (aspectRatio > 1.0) {
		normalizedCoords.x *= aspectRatio;
	} else {
		normalizedCoords.y /= aspectRatio;
	}

	vec2 centeredCoords = (normalizedCoords / u_zoom + u_center) * 2.0;

	vec4 metric = vec4(float(u_iterations), 0.5, 0.0, 0.0);
	switch (u_fractalType) {
		case 0:
			metric = iterateJulia(centeredCoords, vec2(u_cReal, u_cImaginary));
			break;
		case 1:
			metric = iterateMandelbrot(centeredCoords);
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
