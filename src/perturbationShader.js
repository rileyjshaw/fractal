import {
	BLA_BASE_CHUNK_SIZE,
	BLA_LEVEL_STRIDE,
	BLA_MAX_LEVELS,
	BLA_TEXTURE_WIDTH,
	ORBIT_TEXTURE_SIZE,
} from './deepZoomTables.js';

export function generatePerturbationShader() {
	return `#version 300 es
precision highp float;

#define FRACTAL_TYPE_JULIA 0
#define FRACTAL_TYPE_MANDELBROT 1
#define ORBIT_TEXTURE_SIZE ${ORBIT_TEXTURE_SIZE}
#define MIN_SERIES_APPROXIMATION_ITERATIONS 16
#define SERIES_APPROXIMATION_SAFETY_RATIO 0.001
#define BAILOUT_PERTURBATION_DELTA_SQ 1.0e6
// |dz| grows as ~prod(2*|Z|) and overflows float32 in deep zoom, so we carry it as a
// (mantissa, log-offset) pair: log|dz| = log(length(mantissa)) + logOffset.
#define DERIVATIVE_RESCALE_TRIGGER_SQ 1.0e30
#define DERIVATIVE_RESCALE_FACTOR 1.0e-15
#define DERIVATIVE_RESCALE_LOG 34.538776394910684
#define BLA_BASE_CHUNK_SIZE ${BLA_BASE_CHUNK_SIZE}
#define BLA_MAX_LEVELS ${BLA_MAX_LEVELS}
#define BLA_LEVEL_STRIDE ${BLA_LEVEL_STRIDE}
#define BLA_TEXTURE_WIDTH ${BLA_TEXTURE_WIDTH}

uniform sampler2D u_orbitTexture;
// Hierarchical BLA (Bivariate Linear Approximation) table. Each level doubles
// the skip length from BLA_BASE_CHUNK_SIZE; the shader tries largest first and
// falls back to scalar perturbation when validity rejects a pixel.
// Two RGBA32F texels per level/position:
//   texel 0: [A.x, A.y, A_scaleExp, validityRsqLog2]
//   texel 1: [B.x, B.y, B_scaleExp, _unused_]
uniform sampler2D u_blaTable;
uniform sampler2D u_visualPrefixTexture;
uniform vec2 u_resolution;
uniform int u_iterations;
uniform int u_orbitLength;
uniform int u_fractalType;
uniform float u_radiusMantissa;
uniform int u_radiusExponent;
uniform vec2 u_referenceOffset;
uniform float u_escapeRadius;
uniform float u_logEscapeRadius;
uniform vec4 u_poly1;
uniform vec2 u_poly2;
uniform int u_polynomialLimit;
uniform int u_polyScaleExponent;
uniform float u_stripeAveragePresum;
uniform int u_seriesApproximation;
uniform int u_slopeShading;
uniform vec2 u_slopeLightDir;
uniform float u_slopeLightHeight;
uniform float u_slopeLightIntensity;
uniform int u_stripeAverage;

out vec4 FragColor;

const float STRIPE_AVERAGE_DENSITY = 8.0;
// One palette wrap per unit of stripe variation; see fractal.frag for rationale.
const float STRIPE_AVERAGE_COLOR_SCALE = 32.0;
const float STRIPE_AVERAGE_ESCAPE_RADIUS = 64.0;
const float LOG_2 = 0.6931471805599453;

float safeExp2(float exponent) {
	return exp2(clamp(exponent, -126.0, 126.0));
}

bool isFiniteFloat(float value) {
	// GLSL's isnan/isinf are unreliable under fast-math; check magnitude directly.
	return value == value && abs(value) < 3.0e38;
}

float downscaleToExponent(int sourceExponent, int targetExponent) {
	float shift = float(sourceExponent - targetExponent);
	if (shift < -126.0) return 0.0;
	return exp2(min(shift, 126.0));
}

void normalizePerturbation(inout float x, inout float y, inout int exponent) {
	float magSq = x * x + y * y;
	if (!isFiniteFloat(magSq) || magSq <= 0.0) return;
	float shiftValue = clamp(floor(0.5 * log2(magSq)), -120.0, 120.0);
	int shift = int(shiftValue);
	if (shift == 0) return;
	float scale = exp2(-float(shift));
	x *= scale;
	y *= scale;
	exponent += shift;
}

vec2 cmul(vec2 a, vec2 b) {
	return vec2(a.x * b.x - a.y * b.y, a.x * b.y + b.x * a.y);
}

void rescaleDerivative(inout vec2 derivative, inout float logOffset) {
	float derivMagSq = dot(derivative, derivative);
	if (isFiniteFloat(derivMagSq) && derivMagSq > DERIVATIVE_RESCALE_TRIGGER_SQ) {
		derivative *= DERIVATIVE_RESCALE_FACTOR;
		logOffset += DERIVATIVE_RESCALE_LOG;
	}
}

vec3 getOrbit(int i) {
	int row = i / ORBIT_TEXTURE_SIZE;
	int col = i - row * ORBIT_TEXTURE_SIZE;
	return texelFetch(u_orbitTexture, ivec2(col, row), 0).rgb;
}

// Returns the two BLA texels for orbit position k. .a member of texel A holds
// the validity threshold log2(R²); .a of texel B is unused.
void getBLA(int level, int k, out vec4 entryA, out vec4 entryB) {
	int entryIndex = level * BLA_LEVEL_STRIDE + k;
	int texelA = entryIndex * 2;
	int rowA = texelA / BLA_TEXTURE_WIDTH;
	int colA = texelA - rowA * BLA_TEXTURE_WIDTH;
	entryA = texelFetch(u_blaTable, ivec2(colA, rowA), 0);
	entryB = texelFetch(u_blaTable, ivec2(colA + 1, rowA), 0);
}

vec4 getVisualPrefix(int i) {
	int row = i / ORBIT_TEXTURE_SIZE;
	int col = i - row * ORBIT_TEXTURE_SIZE;
	return texelFetch(u_visualPrefixTexture, ivec2(col, row), 0);
}

float smoothEscape(int iteration, float magnitude) {
	float logMag = log(magnitude);
	float logEscapeRadius = u_stripeAverage == 1 ? log(max(u_escapeRadius, STRIPE_AVERAGE_ESCAPE_RADIUS)) : u_logEscapeRadius;
	float logRatio = logMag / max(logEscapeRadius, 1e-6);
	float nu = log2(logRatio);
	return float(iteration) + 1.0 - nu;
}

// See fractal.frag::interiorMetric.
vec4 interiorMetric() {
	return vec4(0.0, 0.0, 1.0, float(u_stripeAverage));
}

float orbitDetailValue(vec2 z) {
	return 1.0 / (1.0 + dot(z, z));
}

float stripeAverageAddend(vec2 z) {
	return 0.5 + 0.5 * sin(STRIPE_AVERAGE_DENSITY * atan(z.y, z.x));
}

// See fractal.frag::stripePaletteOffset.
float stripePaletteOffset(float stripeTotal, float lastStripeValue, int stripeSamples, float magnitudeSq) {
	if (u_stripeAverage != 1 || stripeSamples <= 0) return 0.0;
	float stripeAverageValue = stripeTotal / float(stripeSamples);
	if (stripeSamples == 1 || !isFiniteFloat(magnitudeSq) || magnitudeSq <= 1.000001) {
		return stripeAverageValue * STRIPE_AVERAGE_COLOR_SCALE;
	}
	float previousAverage = (stripeTotal - lastStripeValue) / float(stripeSamples - 1);
	float bailout = max(u_escapeRadius, STRIPE_AVERAGE_ESCAPE_RADIUS);
	float frac = 1.0 + log2(log(bailout * bailout) / max(log(magnitudeSq), 1e-6));
	float mixedAverage = mix(previousAverage, stripeAverageValue, clamp(frac, 0.0, 1.0));
	return mixedAverage * STRIPE_AVERAGE_COLOR_SCALE;
}

float computeSlopeBrightness(vec2 z, vec2 dz) {
	// Analytic-normal Lambertian shading: N = z * conj(dz), normalized.
	vec2 n = vec2(z.x * dz.x + z.y * dz.y, z.y * dz.x - z.x * dz.y);
	float len = length(n);
	if (!isFiniteFloat(len) || len < 1e-20) return 1.0;
	n /= len;
	float lightHeight = max(u_slopeLightHeight, 1e-3);
	float diffuse = (dot(n, normalize(u_slopeLightDir)) + lightHeight) / (1.0 + lightHeight);
	diffuse = clamp(diffuse, 0.0, 1.0);
	return max(0.0, mix(1.0, 0.45 + 0.85 * diffuse, u_slopeLightIntensity));
}

vec2 distanceEstimateMetrics(vec2 z, vec2 dz, float dzLogOffset, float logViewRadius, float pixelRadius) {
	// boundarySignal comes from the Milnor distance estimate; coverage is always 1 since
	// the caller only invokes this for escaped pixels (in deep zoom the distance falls
	// far below a pixel and would otherwise blend toward the interior colour).
	float mag = length(z);
	float dzMantissaMag = length(dz);
	if (!isFiniteFloat(mag) || !isFiniteFloat(dzMantissaMag) || mag <= 1.0 || dzMantissaMag <= 1e-20) {
		return vec2(0.0, 1.0);
	}
	float logDerivativeMag = log(dzMantissaMag) + dzLogOffset;
	float logDistance = log(0.5 * mag * max(log(mag), 1e-6)) - logDerivativeMag;
	float screenDistance = exp(clamp(logDistance - logViewRadius, -30.0, 30.0));
	if (!isFiniteFloat(screenDistance)) return vec2(0.0, 1.0);
	float boundarySignal = clamp(1.0 - smoothstep(0.003, 0.12, screenDistance), 0.0, 1.0);
	return vec2(boundarySignal, 1.0);
}

// See fractal.frag::buildMetric for the metric layout.
vec4 buildMetric(
	float smoothIters,
	float detailTotal,
	float stripeTotal,
	float lastStripeValue,
	int detailSamples,
	float magnitudeSq,
	float coverage,
	float slopeBrightness
) {
	float detailAverage = detailSamples > 0 ? detailTotal / float(detailSamples) : 0.5;
	float detailWeight = coverage < 0.5 ? 1.0 : smoothstep(3.0, 24.0, float(detailSamples));
	float detailBrightness = mix(1.0, mix(0.82, 1.16, detailAverage), detailWeight);
	float stripeOffset = stripePaletteOffset(stripeTotal, lastStripeValue, detailSamples, magnitudeSq);
	float finalCoverage = max(coverage, float(u_stripeAverage));
	return vec4(smoothIters, stripeOffset, detailBrightness * slopeBrightness, finalCoverage);
}

vec4 buildDistanceMetric(
	float smoothIters,
	vec2 z,
	vec2 dz,
	float dzLogOffset,
	float stripeTotal,
	float lastStripeValue,
	int detailSamples,
	float logViewRadius,
	float pixelRadius
) {
	float detailWeight = smoothstep(4.0, 32.0, float(detailSamples));
	vec2 deMetrics = distanceEstimateMetrics(z, dz, dzLogOffset, logViewRadius, pixelRadius);
	float boundarySignal = deMetrics.x;
	float coverage = deMetrics.y;
	float slopeBrightness = u_slopeShading == 1 ? computeSlopeBrightness(z, dz) : 1.0;
	float detailBrightness = mix(1.0, 1.16, boundarySignal * detailWeight);
	float stripeOffset = stripePaletteOffset(stripeTotal, lastStripeValue, detailSamples, dot(z, z));
	float finalCoverage = max(coverage, float(u_stripeAverage));
	return vec4(smoothIters, stripeOffset, detailBrightness * slopeBrightness, finalCoverage);
}

void main() {
	// Branchless aspect-ratio handling: one axis is unit-1, the other extends to the aspect ratio.
	vec2 pixelScale = u_resolution / min(u_resolution.x, u_resolution.y);
	vec2 delta = (gl_FragCoord.xy / u_resolution * 2.0 - 1.0) * pixelScale;
	float pixelRadius = 1.0 / max(u_resolution.x, u_resolution.y);

	int orbitLength = max(u_orbitLength, 1);
	int cq = u_radiusExponent;
	int q = cq;
	float S = safeExp2(float(q));
	float baseDeltaX = (delta.x + u_referenceOffset.x) * u_radiusMantissa;
	float baseDeltaY = (delta.y + u_referenceOffset.y) * u_radiusMantissa;
	bool isJulia = u_fractalType == FRACTAL_TYPE_JULIA;
	float dx = isJulia ? baseDeltaX : 0.0;
	float dy = isJulia ? baseDeltaY : 0.0;

	int k = 0;
	int j = 0;
	vec3 orbit0 = getOrbit(0);
	vec3 orbitCurrent = orbit0;
	float smoothIters = 0.0;
	float detailTotal = 0.0;
	float stripeTotal = 0.0;
	float lastStripeValue = 0.5;
	int detailSamples = 0;
	bool escaped = false;
	vec2 derivative = isJulia ? vec2(1.0, 0.0) : vec2(0.0);
	float derivativeLogOffset = 0.0;
	vec2 finalZ = vec2(0.0);
	vec2 finalDerivative = derivative;
	float finalDerivativeLogOffset = 0.0;
	float logViewRadius = log(max(abs(u_radiusMantissa), 1e-30)) + float(u_radiusExponent) * log(2.0);

	// --- Series-approximation warm start (Mandelbrot quadratic only).
	// The polynomial gives delta_z at iteration polynomialLimit as a cubic in pixel delta.
	// We trust the JS-side stability check up to that iteration but additionally reject
	// the warm start per-pixel if the cubic term is too large vs the quadratic term.
	if (
		u_seriesApproximation == 1 &&
		!isJulia &&
		u_polynomialLimit >= MIN_SERIES_APPROXIMATION_ITERATIONS &&
		u_polynomialLimit < orbitLength - 1
	) {
		float u = delta.x + u_referenceOffset.x;
		float v = delta.y + u_referenceOffset.y;
		float u2 = u * u - v * v;
		float v2 = 2.0 * u * v;
		float u3 = u * u2 - v * v2;
		float v3 = u * v2 + v * u2;

		float linMag = sqrt(u_poly1.x * u_poly1.x + u_poly1.y * u_poly1.y) * sqrt(u * u + v * v);
		float quadMag = sqrt(u_poly1.z * u_poly1.z + u_poly1.w * u_poly1.w) * (u * u + v * v);
		float cubicMag = sqrt(u_poly2.x * u_poly2.x + u_poly2.y * u_poly2.y) * sqrt(u3 * u3 + v3 * v3);

		float dominant = max(linMag, quadMag);
		if (dominant > 1e-30 && cubicMag < SERIES_APPROXIMATION_SAFETY_RATIO * dominant) {
			dx = u_poly1.x * u - u_poly1.y * v
				+ u_poly1.z * u2 - u_poly1.w * v2
				+ u_poly2.x * u3 - u_poly2.y * v3;
			dy = u_poly1.x * v + u_poly1.y * u
				+ u_poly1.z * v2 + u_poly1.w * u2
				+ u_poly2.x * v3 + u_poly2.y * u3;
			q = u_polyScaleExponent + u_radiusExponent;
			S = safeExp2(float(q));
			k = u_polynomialLimit;
			j = u_polynomialLimit;
			orbitCurrent = getOrbit(k);
			// SA skips iterations [1, polynomialLimit], so add back the reference-orbit
			// stripe sum the JS side precomputed; without this the SA-stable region shows
			// a circular seam where its stripe total disagrees with the rest of the frame.
			stripeTotal += u_stripeAveragePresum;
			detailSamples += u_polynomialLimit;
		}
	}

	for (int i = 0; i < u_iterations; i++) {
		// j is the "true" iteration count (offset by polynomialLimit on series-approximation
		// warm starts); cap against u_iterations so SA never inflates total iteration work.
		if (j >= u_iterations || k >= orbitLength - 1) break;

		j += 1;

		bool usedBLA = false;
		for (int blaLevel = BLA_MAX_LEVELS - 1; blaLevel >= 0; blaLevel--) {
			int blaChunkSize = BLA_BASE_CHUNK_SIZE << blaLevel;
			// Leave at least one orbit sample for the scalar path so the reference-end
			// rebase below always gets a chance to run.
			if (k + blaChunkSize >= orbitLength - 1 || j + blaChunkSize - 1 > u_iterations) continue;

			vec4 blaA, blaB;
			getBLA(blaLevel, k, blaA, blaB);
			float dzMagSq = dx * dx + dy * dy;
			float dcMagSq = baseDeltaX * baseDeltaX + baseDeltaY * baseDeltaY;
			float dzLogMagSq = dzMagSq > 0.0 ? log2(dzMagSq) + 2.0 * float(q) : -1.0e30;
			float dcLogMagSq = (!isJulia && dcMagSq > 0.0) ? log2(dcMagSq) + 2.0 * float(cq) : -1.0e30;
			// BLA validity is in absolute terms and bounds max(|dz|, |dc|).
			if (max(dzLogMagSq, dcLogMagSq) < blaA.w) {
				vec2 aMantissa = blaA.xy;
				int aExp = int(blaA.z);

				// Tentatively compute BLA result; don't commit until post-check
				// confirms the pixel hasn't escaped within the chunk.
				float aDx = aMantissa.x * dx - aMantissa.y * dy;
				float aDy = aMantissa.x * dy + aMantissa.y * dx;
				int aTermExp = q + aExp;
				int newQ = aTermExp;
				float newDx = 0.0;
				float newDy = 0.0;

				if (!isJulia) {
					vec2 bMantissa = blaB.xy;
					int bExp = int(blaB.z);
					float bDx = bMantissa.x * baseDeltaX - bMantissa.y * baseDeltaY;
					float bDy = bMantissa.x * baseDeltaY + bMantissa.y * baseDeltaX;
					int bTermExp = bExp + cq;
					newQ = max(aTermExp, bTermExp);
					float aScale = downscaleToExponent(aTermExp, newQ);
					float bScale = downscaleToExponent(bTermExp, newQ);
					newDx = aDx * aScale + bDx * bScale;
					newDy = aDy * aScale + bDy * bScale;
				} else {
					newDx = aDx;
					newDy = aDy;
				}
				normalizePerturbation(newDx, newDy, newQ);

				// Post-BLA escape check. The linear approximation breaks when the
				// pixel truly escapes within the chunk — the dropped dz² term
				// becomes dominant and BLA's predicted dz_after is wrong. If
				// |Z + dz_after| at the chunk end exceeds escape, BLA's prediction
				// is unreliable; fall through to per-iter (correct but slower).
				// Without this check the wrong |z| feeds smoothEscape() and
				// produces banded coloring concentric with whatever minibrot the
				// pixel was near.
				float newS = safeExp2(float(newQ));
				vec3 chunkEndOrbit = getOrbit(k + blaChunkSize);
				float chunkEndScale = safeExp2(chunkEndOrbit.z);
				float chunkZx = chunkEndOrbit.x * chunkEndScale + newS * newDx;
				float chunkZy = chunkEndOrbit.y * chunkEndScale + newS * newDy;
				float chunkZMagSq = chunkZx * chunkZx + chunkZy * chunkZy;
				float escapeRadiusCheck = u_stripeAverage == 1 ? max(u_escapeRadius, STRIPE_AVERAGE_ESCAPE_RADIUS) : u_escapeRadius;
				if (isFiniteFloat(chunkZMagSq) && chunkZMagSq < escapeRadiusCheck * escapeRadiusCheck) {
					vec4 prefixBefore = getVisualPrefix(k);
					vec4 prefixAfter = getVisualPrefix(k + blaChunkSize);

					// Keep visual accumulators continuous across the BLA validity
					// boundary. The reference samples are a good approximation exactly
					// where BLA is valid because perturbations are small by definition.
					detailTotal += prefixAfter.x - prefixBefore.x;
					stripeTotal += prefixAfter.y - prefixBefore.y;
					lastStripeValue = prefixAfter.z;
					detailSamples += blaChunkSize;

					if (isJulia) {
						derivative = cmul(aMantissa, derivative);
						derivativeLogOffset += float(aExp) * LOG_2;
					} else {
						vec2 bMantissa = blaB.xy;
						int bExp = int(blaB.z);
						vec2 aDerivative = cmul(aMantissa, derivative);
						float aLogScale = derivativeLogOffset + float(aExp) * LOG_2;
						float bLogScale = float(bExp) * LOG_2;
						float commonLogScale = max(aLogScale, bLogScale);
						float aDerivativeScale = exp(clamp(aLogScale - commonLogScale, -80.0, 0.0));
						float bDerivativeScale = exp(clamp(bLogScale - commonLogScale, -80.0, 0.0));
						derivative = aDerivative * aDerivativeScale + bMantissa * bDerivativeScale;
						derivativeLogOffset = commonLogScale;
					}
					rescaleDerivative(derivative, derivativeLogOffset);

					dx = newDx;
					dy = newDy;
					q = newQ;
					S = newS;
					k += blaChunkSize;
					j += blaChunkSize - 1;
					orbitCurrent = chunkEndOrbit;
					usedBLA = true;
					break;
				}
			}
		}
		if (usedBLA) continue;

		int orbitScalePrev = int(orbitCurrent.z);
		float previousReferenceScale = safeExp2(float(orbitScalePrev));
		vec2 previousZ = orbitCurrent.xy * previousReferenceScale + S * vec2(dx, dy);
		derivative = cmul(vec2(2.0 * previousZ.x, 2.0 * previousZ.y), derivative);
		if (!isJulia) {
			derivative += vec2(1.0, 0.0);
		}
		rescaleDerivative(derivative, derivativeLogOffset);

		vec2 linearTerm = vec2(
			2.0 * orbitCurrent.x * dx - 2.0 * orbitCurrent.y * dy,
			2.0 * orbitCurrent.x * dy + 2.0 * orbitCurrent.y * dx
		);
		vec2 squareTerm = vec2(dx * dx - dy * dy, 2.0 * dx * dy);
		int linearExp = q + orbitScalePrev;
		int squareExp = q + q;
		int targetQ = max(linearExp, squareExp);
		if (!isJulia) {
			targetQ = max(targetQ, cq);
		}
		float linearScale = downscaleToExponent(linearExp, targetQ);
		float squareScale = downscaleToExponent(squareExp, targetQ);
		vec2 nextDelta = linearTerm * linearScale + squareTerm * squareScale;
		if (!isJulia) {
			float dcScale = downscaleToExponent(cq, targetQ);
			nextDelta += vec2(baseDeltaX, baseDeltaY) * dcScale;
		}
		dx = nextDelta.x;
		dy = nextDelta.y;
		q = targetQ;
		normalizePerturbation(dx, dy, q);
		S = safeExp2(float(q));

		k += 1;
		vec3 orbitNext = getOrbit(k);
		float referenceScale = safeExp2(orbitNext.z);
		float fx = orbitNext.x * referenceScale + S * dx;
		float fy = orbitNext.y * referenceScale + S * dy;
		float magnitudeSq = fx * fx + fy * fy;
		bool finiteMagnitude = isFiniteFloat(magnitudeSq);

		if (finiteMagnitude) {
			finalZ = vec2(fx, fy);
			finalDerivative = derivative;
			finalDerivativeLogOffset = derivativeLogOffset;
			detailTotal += orbitDetailValue(finalZ);
			lastStripeValue = stripeAverageAddend(finalZ);
			stripeTotal += lastStripeValue;
			detailSamples += 1;
		}

		if (!finiteMagnitude) {
			smoothIters = float(j);
			escaped = true;
			orbitCurrent = orbitNext;
			break;
		}

		float escapeRadius = u_stripeAverage == 1 ? max(u_escapeRadius, STRIPE_AVERAGE_ESCAPE_RADIUS) : u_escapeRadius;
		if (magnitudeSq > escapeRadius * escapeRadius) {
			// j was incremented at the top of the loop body; pass j-1 so this matches
			// fractal.frag (which passes its pre-increment loop index) and the palette
			// doesn't shift one band at the standard/deep handoff.
			smoothIters = smoothEscape(j - 1, sqrt(magnitudeSq));
			escaped = true;
			orbitCurrent = orbitNext;
			break;
		}

		float perturbationDeltaSq = dx * dx + dy * dy;
		if (isFiniteFloat(perturbationDeltaSq) && perturbationDeltaSq > BAILOUT_PERTURBATION_DELTA_SQ) {
			dx *= 0.5;
			dy *= 0.5;
			q += 1;
			S = safeExp2(float(q));
		}

		// Iteration-extension rebase: when the reference orbit runs out, fold the current
		// full z back into a fresh perturbation from orbit[0]. Mandelbrot's orbit[0] = 0,
		// Julia's = the reference center; the fold math (dx, dy = fx - orbit0.xy * scale)
		// generalises to both. With long-orbit references (the normal case after the recent
		// recompute headroom changes) this never fires. It only fires when the reference
		// escaped early — in that case Julia would otherwise show a solid view, since
		// without the fold every still-unescaped pixel returns interiorMetric(). Post-rebase
		// classifications carry per-pixel artifacts, but a blocky fractal is much more
		// useful than a flat one.
		if (k >= orbitLength - 1) {
			float referenceStartScale = safeExp2(orbit0.z);
			dx = fx - orbit0.x * referenceStartScale;
			dy = fy - orbit0.y * referenceStartScale;
			k = 0;
			q = 0;
			S = 1.0;
			orbitNext = orbit0;
		}

		orbitCurrent = orbitNext;
	}

	if (escaped) {
		FragColor = buildDistanceMetric(
			smoothIters,
			finalZ,
			finalDerivative,
			finalDerivativeLogOffset,
			stripeTotal,
			lastStripeValue,
			detailSamples,
			logViewRadius,
			pixelRadius
		);
	} else {
		FragColor = interiorMetric();
	}
}
`;
}
