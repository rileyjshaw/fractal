#version 300 es
precision highp float;

uniform vec2 u_resolution;
uniform vec2 u_center;
uniform float u_zoom;
uniform int u_exponent;
// TODO: Use this.
// uniform vec3 u_colors[8];

in vec2 v_texCoord;
out vec4 FragColor;

int maxIterations = 512;

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

int iterateMandelbrot(vec2 coord){
	vec2 z = vec2(0.0);
	for(int i = 0; i < maxIterations; i++) {
		z = cpow(z, u_exponent) + coord;
		if (length(z) > 2.0) return i;
	}
	return maxIterations;
}

void main() {
	// Normalize to [-1, 1].
	vec2 normalizedCoords = (gl_FragCoord.xy / u_resolution) * 2.0 - 1.0;

	// Center and zoom.
	vec2 centeredCoords = (normalizedCoords / u_zoom + u_center) * 2.0;

	int nIterations = iterateMandelbrot(centeredCoords);
	float shade = 1.0 - sqrt(float(nIterations) / float(maxIterations));
	FragColor = vec4(shade, shade, shade, 1.0);
}
