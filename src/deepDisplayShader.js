export function generateDeepDisplayShader() {
	return `#version 300 es
precision highp float;

#define N_COLORS 32

in vec2 v_uv;

uniform sampler2D u_liveMetrics;
// Palette is uploaded as SRGB8_ALPHA8: the GPU decodes each entry to linear
// on sample, and LINEAR filtering interpolates between neighbours in linear
// space — gamma-correct palette blends without per-pixel pow().
uniform sampler2D u_palette;
// Linear-space interior color (sRGB→linear baked on the CPU side).
uniform vec3 u_insideColor;
uniform float u_paletteFrame;
uniform float u_colorScale;

out vec4 outColor;

// Bumped above 1 if more headroom is needed; tone map handles roll-off.
const float EXPOSURE = 1.0;

// ACES filmic tone mapping (Narkowicz fit). Linear HDR in, linear LDR out.
vec3 toneMapACES(vec3 x) {
	const float a = 2.51;
	const float b = 0.03;
	const float c = 2.43;
	const float d = 0.59;
	const float e = 0.14;
	return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
	vec3 cutoff = vec3(lessThanEqual(c, vec3(0.0031308)));
	vec3 higher = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
	vec3 lower = c * 12.92;
	return mix(higher, lower, cutoff);
}

bool isFiniteFloat(float value) {
	return value == value && abs(value) < 3.0e38;
}

vec4 sanitizeMetric(vec4 metric) {
	if (
		!isFiniteFloat(metric.x) ||
		!isFiniteFloat(metric.y) ||
		!isFiniteFloat(metric.z) ||
		!isFiniteFloat(metric.w)
	) {
		return vec4(0.0, 0.0, 1.0, 0.0);
	}
	return vec4(metric.x, metric.y, clamp(metric.z, 0.0, 4.0), clamp(metric.w, 0.0, 1.0));
}

vec3 getPaletteColor(vec4 metric) {
	float colorIdx = metric.x * u_colorScale + metric.y + u_paletteFrame;
	// Linear-space sample, blended in linear by the SRGB8_ALPHA8 + LINEAR setup.
	vec3 outsideColor = texture(u_palette, vec2(colorIdx / float(N_COLORS), 0.5)).rgb;
	// No clamp: brightness/detail/slope can push above 1 — tone map handles roll-off.
	return mix(u_insideColor, outsideColor * metric.z, metric.w);
}

void main() {
	vec4 metric = sanitizeMetric(texture(u_liveMetrics, v_uv));
	vec3 linearColor = getPaletteColor(metric) * EXPOSURE;
	vec3 mapped = toneMapACES(linearColor);
	outColor = vec4(linearToSrgb(mapped), 1.0);
}
`;
}
