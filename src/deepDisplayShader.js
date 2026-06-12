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
uniform int u_stripeAverage;
uniform vec2 u_slopeLightDir;
uniform float u_slopeLightHeight;
uniform float u_slopeLightIntensity;
uniform vec2 u_resolution;
uniform float u_previewScale;
uniform vec2 u_previewOffset;

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

// Stripe offset is pre-scaled to one palette wrap per unit of variation.
const float STRIPE_COLOR_DENSITY_SCALE = 5.0;

float paletteIndexAt(vec4 metric) {
	return u_stripeAverage == 1
		? metric.y * u_colorScale * STRIPE_COLOR_DENSITY_SCALE
		: metric.x * u_colorScale;
}

float effectiveCoverage(vec4 metric) {
	return u_stripeAverage == 1 ? 1.0 : metric.w;
}

bool isShadableEscape(vec4 metric) {
	return effectiveCoverage(metric) > 0.5 && metric.x > 0.0;
}

// Gradient-based slope shading when no analytic DE normal is available.
float computeGradientSlopeBrightness(vec4 metric, ivec2 texel, ivec2 size) {
	if (u_slopeShading != 1 || !isShadableEscape(metric)) return 1.0;

	vec4 right = sanitizeMetric(texelFetch(u_liveMetrics, min(texel + ivec2(1, 0), size - 1), 0));
	vec4 left = sanitizeMetric(texelFetch(u_liveMetrics, max(texel - ivec2(1, 0), ivec2(0)), 0));
	vec4 above = sanitizeMetric(texelFetch(u_liveMetrics, min(texel + ivec2(0, 1), size - 1), 0));
	vec4 below = sanitizeMetric(texelFetch(u_liveMetrics, max(texel - ivec2(0, 1), ivec2(0)), 0));

	float center = paletteIndexAt(metric);
	bool rightOk = isShadableEscape(right);
	bool leftOk = isShadableEscape(left);
	bool aboveOk = isShadableEscape(above);
	bool belowOk = isShadableEscape(below);
	float gradX = rightOk && leftOk
		? (paletteIndexAt(right) - paletteIndexAt(left)) * 0.5
		: (rightOk ? paletteIndexAt(right) - center : (leftOk ? center - paletteIndexAt(left) : 0.0));
	float gradY = aboveOk && belowOk
		? (paletteIndexAt(above) - paletteIndexAt(below)) * 0.5
		: (aboveOk ? paletteIndexAt(above) - center : (belowOk ? center - paletteIndexAt(below) : 0.0));

	vec2 gradient = vec2(gradX, gradY) * 2.0;
	if (!isFiniteFloat(gradient.x) || !isFiniteFloat(gradient.y)) return 1.0;
	float lightHeight = max(u_slopeLightHeight, 1e-3);
	vec3 normal = normalize(vec3(-gradient, 1.0));
	vec3 light = normalize(vec3(normalize(u_slopeLightDir), lightHeight));
	float diffuse = clamp(dot(normal, light), 0.0, 1.0);
	float flatDiffuse = light.z;
	float shaped = (0.45 + 0.85 * diffuse) / (0.45 + 0.85 * flatDiffuse);
	return max(0.0, mix(1.0, shaped, u_slopeLightIntensity));
}

vec3 getPaletteColor(vec4 metric, ivec2 texel, ivec2 size) {
	VisualMetric visualMetric = unpackVisualMetric(metric.z);
	float colorIdx = paletteIndexAt(metric) + u_paletteFrame;
	// Linear-space sample, blended in linear by the SRGB8_ALPHA8 + LINEAR setup.
	vec3 outsideColor = texture(u_palette, vec2(colorIdx / float(N_COLORS), 0.5)).rgb;
	float slopeBrightness = visualMetric.hasNormal
		? computeSlopeBrightness(visualMetric)
		: computeGradientSlopeBrightness(metric, texel, size);
	// No clamp: brightness/detail/slope can push above 1 — tone map handles roll-off.
	float brightness = visualMetric.detailBrightness * slopeBrightness;
	vec3 insideColor = u_insideColor * visualMetric.detailBrightness;
	return mix(insideColor, outsideColor * brightness, effectiveCoverage(metric));
}

ivec2 clampTexel(ivec2 texel, ivec2 size) {
	return clamp(texel, ivec2(0), size - 1);
}

vec3 displayColorAt(ivec2 texel, ivec2 size) {
	vec4 metric = sanitizeMetric(texelFetch(u_liveMetrics, texel, 0));
	return getPaletteColor(metric, texel, size);
}

void main() {
	ivec2 size = textureSize(u_liveMetrics, 0);
	vec2 pixelScale = u_resolution / min(u_resolution.x, u_resolution.y);
	vec2 viewDelta = (v_uv * 2.0 - 1.0) * pixelScale;
	vec2 anchorDelta = viewDelta * u_previewScale + u_previewOffset;
	vec2 anchorUv = (anchorDelta / pixelScale + 1.0) * 0.5;

	vec3 linearColor;
	if (u_previewScale == 1.0 && u_previewOffset == vec2(0.0)) {
		linearColor = displayColorAt(clampTexel(ivec2(anchorUv * vec2(size)), size), size);
	} else {
		// Bilinear blend of final colors — the packed metric channel can't be filtered.
		vec2 sourcePos = anchorUv * vec2(size) - 0.5;
		vec2 cornerWeights = fract(sourcePos);
		ivec2 base = ivec2(floor(sourcePos));
		vec3 c00 = displayColorAt(clampTexel(base, size), size);
		vec3 c10 = displayColorAt(clampTexel(base + ivec2(1, 0), size), size);
		vec3 c01 = displayColorAt(clampTexel(base + ivec2(0, 1), size), size);
		vec3 c11 = displayColorAt(clampTexel(base + ivec2(1, 1), size), size);
		linearColor = mix(mix(c00, c10, cornerWeights.x), mix(c01, c11, cornerWeights.x), cornerWeights.y);
	}

	vec3 mapped = toneMapACES(linearColor * EXPOSURE);
	outColor = vec4(linearToSrgb(mapped), 1.0);
}
`;
}
