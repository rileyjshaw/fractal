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

void main() {
	vec4 metric = texture(u_liveMetrics, v_uv);
	outColor = vec4(getPaletteColor(metric), 1.0);
}
`;
}
