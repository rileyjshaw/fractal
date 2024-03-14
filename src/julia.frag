#version 300 es
precision highp float;

#define N_COLORS 32

uniform vec2 u_resolution;
uniform int u_frame;
uniform vec2 u_center;
uniform float u_zoom;
uniform int u_exponent;
uniform float u_cReal;
uniform float u_cImaginary;
uniform vec3 u_colors[N_COLORS];

in vec2 v_texCoord;
out vec4 FragColor;

int maxIterations = 256;

// Takes a complex number as a vector (real, imaginary) and returns the square.
vec2 squareComplexNumber(vec2 n) {
	return vec2(
		pow(n.x, 2.0) - pow(n.y, 2.0),
		2.0 * n.x * n.y
	);
}

vec2 cmul (vec2 a, vec2 b) {
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

int iterateJulia(vec2 coord, vec2 c) {
	vec2 z = coord;
	for(int i = 0; i < maxIterations; i++) {
		z = cpow(z, u_exponent) + c;
		if (length(z) > 2.0) return i;
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

	int nIterations = iterateJulia(centeredCoords, vec2(u_cReal, u_cImaginary));
	int colorIdx = (nIterations == 0 || nIterations == maxIterations) ? 0 : (nIterations + u_frame) % N_COLORS;
	vec3 color = u_colors[colorIdx];
	FragColor = vec4(color.rgb, 1.0);
}
