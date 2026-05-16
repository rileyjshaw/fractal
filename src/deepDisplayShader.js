export function generateDeepDisplayShader() {
	return `#version 300 es
precision highp float;

#define N_COLORS 32

in vec2 v_uv;

uniform sampler2D u_liveMetrics;
uniform vec3 u_colors[N_COLORS];
uniform float u_paletteFrame;
uniform float u_colorScale;

out vec4 outColor;

// See fractal.frag::buildMetric for the metric layout.
vec3 srgbToLinear(vec3 color) {
	color = clamp(color, 0.0, 1.0);
	vec3 lower = color / 12.92;
	vec3 higher = pow((color + 0.055) / 1.055, vec3(2.4));
	return mix(higher, lower, lessThanEqual(color, vec3(0.04045)));
}

vec3 linearToSrgb(vec3 color) {
	color = max(color, vec3(0.0));
	vec3 lower = color * 12.92;
	vec3 higher = 1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055;
	return mix(higher, lower, lessThanEqual(color, vec3(0.0031308)));
}

vec3 mixPaletteLinear(int fromIdx, int toIdx, float t) {
	return mix(srgbToLinear(u_colors[fromIdx]), srgbToLinear(u_colors[toIdx]), t);
}

vec3 getPaletteColor(vec4 metric) {
	float colorIdx = metric.x * u_colorScale + metric.y + u_paletteFrame;
	float wrappedIdx = mod(floor(colorIdx), float(N_COLORS));
	float t = fract(colorIdx);
	int fromIdx = int(wrappedIdx);
	int toIdx = (fromIdx + 1) % N_COLORS;
	vec3 outsideColor = mixPaletteLinear(fromIdx, toIdx, t) * metric.z;
	vec3 insideColor = mixPaletteLinear(0, 1, 0.5) * 0.18;
	return linearToSrgb(clamp(mix(insideColor, outsideColor, metric.w), 0.0, 1.0));
}

void main() {
	vec4 metric = texture(u_liveMetrics, v_uv);
	outColor = vec4(getPaletteColor(metric), 1.0);
}
`;
}
