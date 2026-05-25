export function generateDeepDisplayShader() {
	return `#version 300 es
precision highp float;

#define N_COLORS 32

in vec2 v_uv;

uniform sampler2D u_liveMetrics;
// Pre-baked palette in sRGB-space, RGBA8 with LINEAR + REPEAT. GPU handles
// inter-entry interpolation and wrap-around for free; we output directly to
// the canvas without color-space conversion. Mixing in sRGB is slightly less
// colorimetrically correct than linear-space mixing but eliminates per-pixel
// pow() calls — display:draw was bottlenecked by linearToSrgb before this.
uniform sampler2D u_palette;
// Pre-baked (sRGB-space) interior color. Used when metric.w is low.
uniform vec3 u_insideColor;
uniform float u_paletteFrame;
uniform float u_colorScale;

out vec4 outColor;

vec3 getPaletteColor(vec4 metric) {
	float colorIdx = metric.x * u_colorScale + metric.y + u_paletteFrame;
	// colorIdx / N_COLORS into [0,1]; GL_REPEAT wraps, GL_LINEAR interpolates
	// between adjacent palette entries.
	vec3 outsideColor = texture(u_palette, vec2(colorIdx / float(N_COLORS), 0.5)).rgb * metric.z;
	return clamp(mix(u_insideColor, outsideColor, metric.w), 0.0, 1.0);
}

void main() {
	vec4 metric = texture(u_liveMetrics, v_uv);
	outColor = vec4(getPaletteColor(metric), 1.0);
}
`;
}
