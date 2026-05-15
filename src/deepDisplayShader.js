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

// Metric layout (set by perturbationShader/fractal.frag buildMetric/buildDistanceMetric):
//   .x = smoothed iteration count
//   .y = signed boundary/detail signal (range [-0.5, 0.5], typically [0, 0.5] near escape)
//   .z = combined brightness multiplier (detail brightness * slope brightness)
//   .w = sub-pixel coverage in [0, 1]; 0 = interior, 1 = clearly outside set
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

void main() {
	vec4 metric = texture(u_liveMetrics, v_uv);
	outColor = vec4(getPaletteColor(metric), 1.0);
}
`;
}
