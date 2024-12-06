#version 300 es
precision highp float;

#define N_COLORS 32
#define MAX_ITERATIONS 256

uniform vec2 u_resolution;
uniform float u_frame;
uniform vec2 u_center;
uniform float u_zoom;
uniform uint u_fractalType;
uniform int u_exponent;
uniform float u_cReal;
uniform float u_cImaginary;
uniform vec3 u_colors[N_COLORS];
uniform bool u_transitionSmoothing;
uniform float u_escapeRadius;
uniform float u_logEscapeRadius;
uniform float u_spacing;

in vec2 v_texCoord;
out vec4 FragColor;

const float maxIterations = float(MAX_ITERATIONS);

vec2 cmul(vec2 a, vec2 b) {
	return vec2(a.x * b.x - a.y * b.y, a.x * b.y + b.x * a.y);
}

// Complex power.
vec2 cpow(vec2 z, int n) {
	vec2 sum = z;
	for (int i = 0; i < n - 1; i++) {
		sum = cmul(sum, z);
	}
	return sum;
}

float iterateJulia(vec2 coord, vec2 c) {
	vec2 z = coord;
	for(int i = 0; i < MAX_ITERATIONS; i++) {
		z = cpow(z, u_exponent) + c;
		float mag = length(z);
		if (mag > u_escapeRadius) {
			float nu = log(log(mag) / u_logEscapeRadius) / u_logEscapeRadius;
			return float(i) + float(u_transitionSmoothing) * (1.0 - nu);
		}
	}
	return maxIterations;
}

float iterateMandelbrot(vec2 coord) {
	vec2 z = vec2(0.0);
	for(int i = 0; i < MAX_ITERATIONS; i++) {
		z = cpow(z, u_exponent) + coord;
		float mag = length(z);
		if (mag > u_escapeRadius) {
			float nu = log(log(mag) / u_logEscapeRadius) / u_logEscapeRadius;
			return float(i) + float(u_transitionSmoothing) * (1.0 - nu);
		}
	}
	return maxIterations;
}

float iterateBurningShip(vec2 coord) {
	coord = vec2(1.0, -1.0) * coord;
	vec2 z = vec2(0.0);
	for(int i = 0; i < MAX_ITERATIONS; i++) {
		z = cpow(abs(z), u_exponent) + coord;
		float mag = length(z);
		if (mag > u_escapeRadius) {
			float nu = log(log(mag) / u_logEscapeRadius) / u_logEscapeRadius;
			return float(i) + float(u_transitionSmoothing) * (1.0 - nu);
		}
	}
	return maxIterations;
}

float iterateMandala(vec2 coord, vec2 c) {
	vec2 z = coord;
	for(int i = 0; i < MAX_ITERATIONS; i++) {
		z = cpow(abs(z), u_exponent) + c;
		float mag = length(z);
		if (mag > u_escapeRadius) {
			float nu = log(log(mag) / u_logEscapeRadius) / u_logEscapeRadius;
			return float(i) + float(u_transitionSmoothing) * (1.0 - nu);
		}
	}
	return maxIterations;
}

void main() {
	float aspectRatio = u_resolution.x / u_resolution.y;

	// Normalize to [-1, 1], adjusting to maintain a 1:1 aspect ratio.
	vec2 normalizedCoords = (gl_FragCoord.xy / u_resolution) * 2.0 - 1.0;

	if (aspectRatio > 1.0) {
		// Landscape.
		normalizedCoords.x *= aspectRatio;
	} else {
		// Portrait.
		normalizedCoords.y /= aspectRatio;
	}

	// Center and zoom.
	vec2 centeredCoords = (normalizedCoords / u_zoom + u_center) * 2.0;

	float smoothIters;
	switch (u_fractalType) {
		case 0u:
			smoothIters = iterateJulia(centeredCoords, vec2(u_cReal, u_cImaginary));
			break;
		case 1u:
			smoothIters = iterateMandelbrot(centeredCoords);
			break;
		case 2u:
			smoothIters = iterateBurningShip(centeredCoords);
			break;
		case 3u:
			smoothIters = iterateMandala(centeredCoords, vec2(u_cReal, u_cImaginary));
			break;
	}

	float colorIdx = smoothIters * 0.2 + u_frame;
	float t = fract(colorIdx);
	int fromIdx = (N_COLORS + int(colorIdx)) % N_COLORS;
	int toIdx = (fromIdx + 1) % N_COLORS;

	vec3 color = mix(u_colors[fromIdx], u_colors[toIdx], t);
	FragColor = vec4(color, 1.0);
}