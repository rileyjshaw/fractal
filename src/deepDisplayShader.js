import { GLSL_IS_FINITE, GLSL_PACK_CONSTANTS, N_COLORS } from './shaderCommon.js';

export function generateDeepDisplayShader() {
	return `#version 300 es
precision highp float;

#define N_COLORS ${N_COLORS}

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
uniform int u_slopeShading;
uniform vec2 u_slopeLightDir;
uniform float u_slopeLightHeight;
uniform float u_slopeLightIntensity;

out vec4 outColor;

// Bumped above 1 if more headroom is needed; tone map handles roll-off.
const float EXPOSURE = 1.0;
${GLSL_PACK_CONSTANTS}const float METRIC_PACK_MAX = 16777215.0;
${GLSL_IS_FINITE}
struct VisualMetric {
	float detailBrightness;
	float normalAngle;
	bool hasNormal;
};

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

vec4 sanitizeMetric(vec4 metric) {
	if (
		!isFiniteFloat(metric.x) ||
		!isFiniteFloat(metric.y) ||
		!isFiniteFloat(metric.z) ||
		!isFiniteFloat(metric.w)
	) {
		return vec4(0.0, 0.0, 1.0, 0.0);
	}
	return vec4(metric.x, metric.y, clamp(metric.z, 0.0, METRIC_PACK_MAX), clamp(metric.w, 0.0, 1.0));
}

VisualMetric unpackVisualMetric(float packedValue) {
	float packed = floor(clamp(packedValue, 0.0, METRIC_PACK_MAX) + 0.5);
	float detailBin = floor(packed / METRIC_PACK_COMPONENT_SCALE);
	float normalBin = packed - detailBin * METRIC_PACK_COMPONENT_SCALE;
	VisualMetric metric;
	metric.detailBrightness = detailBin / METRIC_PACK_DETAIL_SCALE;
	metric.hasNormal = normalBin < METRIC_PACK_NORMAL_SENTINEL;
	metric.normalAngle = metric.hasNormal ? normalBin / METRIC_PACK_NORMAL_BINS * TAU : 0.0;
	return metric;
}

float computeSlopeBrightness(VisualMetric visualMetric) {
	if (u_slopeShading != 1 || !visualMetric.hasNormal) return 1.0;
	vec2 normal = vec2(cos(visualMetric.normalAngle), sin(visualMetric.normalAngle));
	float lightHeight = max(u_slopeLightHeight, 1e-3);
	float diffuse = (dot(normal, normalize(u_slopeLightDir)) + lightHeight) / (1.0 + lightHeight);
	diffuse = clamp(diffuse, 0.0, 1.0);
	return max(0.0, mix(1.0, 0.45 + 0.85 * diffuse, u_slopeLightIntensity));
}

vec3 getPaletteColor(vec4 metric) {
	VisualMetric visualMetric = unpackVisualMetric(metric.z);
	float colorIdx = metric.x * u_colorScale + metric.y + u_paletteFrame;
	// Linear-space sample, blended in linear by the SRGB8_ALPHA8 + LINEAR setup.
	vec3 outsideColor = texture(u_palette, vec2(colorIdx / float(N_COLORS), 0.5)).rgb;
	// No clamp: brightness/detail/slope can push above 1 — tone map handles roll-off.
	float brightness = visualMetric.detailBrightness * computeSlopeBrightness(visualMetric);
	return mix(u_insideColor, outsideColor * brightness, metric.w);
}

void main() {
	vec4 metric = sanitizeMetric(texture(u_liveMetrics, v_uv));
	vec3 linearColor = getPaletteColor(metric) * EXPOSURE;
	vec3 mapped = toneMapACES(linearColor);
	outColor = vec4(linearToSrgb(mapped), 1.0);
}
`;
}
