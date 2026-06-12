import {
	BLA_BASE_CHUNK_SIZE,
	BLA_LEVEL_STRIDE,
	BLA_MAX_LEVELS,
	BLA_TEXTURE_WIDTH,
	ORBIT_TEXTURE_SIZE,
} from './deepZoomTables.js';
import {
	GLSL_IS_FINITE,
	GLSL_METRIC_SHARED,
	GLSL_PACK_CONSTANTS,
	N_COLORS,
	STRIPE_EWMA_ALPHA,
} from './shaderCommon.js';

const FRACTAL_TYPE_JULIA = 0;
const FRACTAL_TYPE_MANDELBROT = 1;
const FRACTAL_TYPE_BURNING_SHIP = 2;
const FRACTAL_TYPE_MANDALA = 3;

// Exact integer binomial coefficients C(n, 0..n); n ≤ 16 keeps every value (max
// C(16,8) = 12870) exactly representable in float32, so they can be emitted as
// literals in the generated shader.
function binomialCoefficients(n) {
	const coefficients = [1];
	for (let k = 1; k <= n; k++) {
		coefficients.push((coefficients[k - 1] * (n - k + 1)) / k);
	}
	return coefficients;
}

// Unrolled mantissa/exponent accumulation of the power-N perturbation
//   δ' = Σ_{k=1..N} C(N,k) base^(N−k) delta^k [+ δc]
// where base = reference mantissa (exponent baseExpVar) and delta = perturbation
// mantissa (exponent deltaExpVar). Term exponents are linear in k, so the dominant
// term sits at one of the ends; everything is aligned to that and summed. Assigns
// dx, dy, q. Used by both the analytic (base = Z) and folded (base = (|X|, |Y|),
// delta = ω) steps.
function glslBinomialPerturbation(exponent, { baseExpr, deltaExpr, baseExpVar, deltaExpVar, hasDeltaC }) {
	const n = exponent;
	const coefficients = binomialCoefficients(n);
	const lines = [];
	lines.push(`vec2 basePow1 = ${baseExpr};`);
	for (let j = 2; j <= n - 1; j++) {
		lines.push(`vec2 basePow${j} = cmul(basePow${j - 1}, basePow1);`);
	}
	lines.push(`vec2 deltaPow = ${deltaExpr};`);
	lines.push(`int targetQ = max(${n - 1} * ${baseExpVar} + ${deltaExpVar}, ${n} * ${deltaExpVar});`);
	if (hasDeltaC) {
		lines.push('targetQ = max(targetQ, cq);');
	}
	lines.push('vec2 acc = vec2(0.0);');
	for (let k = 1; k <= n; k++) {
		if (k > 1) {
			lines.push(`deltaPow = cmul(deltaPow, ${deltaExpr});`);
		}
		const basePower = n - k;
		const term = basePower === 0 ? 'deltaPow' : `cmul(basePow${basePower}, deltaPow)`;
		const coefficient = coefficients[k] === 1 ? '' : `${coefficients[k]}.0 * `;
		lines.push(
			`acc += ${coefficient}${term} * downscaleToExponent(${basePower} * ${baseExpVar} + ${k} * ${deltaExpVar}, targetQ);`,
		);
	}
	if (hasDeltaC) {
		lines.push('acc += vec2(baseDeltaX, baseDeltaY) * downscaleToExponent(cq, targetQ);');
	}
	lines.push('dx = acc.x;');
	lines.push('dy = acc.y;');
	lines.push('q = targetQ;');
	return lines.join('\n\t\t\t');
}

// Single-component diffabs(a, t) = |a + t| − |a| in mantissa/exponent form, for the
// folded power step: a = reference component (mantissa `aMantExpr`, exponent
// orbitScalePrev), t = delta component (mantissa `tMantExpr`, exponent q). Writes
// `${out}Mant` / `${out}Exp`.
function glslComponentDiffabs(out, aMantExpr, tMantExpr) {
	return `int sumExp${out} = max(orbitScalePrev, q);
			float sumMant${out} = ${aMantExpr} * downscaleToExponent(orbitScalePrev, sumExp${out})
				+ ${tMantExpr} * downscaleToExponent(q, sumExp${out});
			float ${out}Mant;
			int ${out}Exp;
			if (${aMantExpr} >= 0.0 ? sumMant${out} >= 0.0 : sumMant${out} <= 0.0) {
				// Same side of the fold: |a + t| − |a| = ±t.
				${out}Mant = ${aMantExpr} >= 0.0 ? ${tMantExpr} : -${tMantExpr};
				${out}Exp = q;
			} else {
				// Crossed the fold: |a + t| − |a| = ∓(2a + t).
				${out}Exp = max(orbitScalePrev + 1, q);
				float cross${out} = ${aMantExpr} * downscaleToExponent(orbitScalePrev + 1, ${out}Exp)
					+ ${tMantExpr} * downscaleToExponent(q, ${out}Exp);
				${out}Mant = ${aMantExpr} >= 0.0 ? -cross${out} : cross${out};
			}`;
}

// Deep-zoom perturbation pass. The fractal type and exponent are baked into the
// generated source: only the selected formula's delta recurrence is emitted, the
// power-N binomial is unrolled with literal coefficients, and every per-pixel formula
// branch is resolved at generation time. main.js recreates the renderer when either
// changes.
//
// BLA (and the visual-prefix stripe/min approximations that ride on it) only exists
// for the analytic quadratic variants — the folded fold lines and the non-quadratic
// validity bound aren't covered by the table builder. Everything else runs scalar
// perturbation with Brent cycle detection so interior pixels don't burn the budget.
export function generatePerturbationShader({ fractalType = 1, exponent = 2 } = {}) {
	const isJulia = fractalType === FRACTAL_TYPE_JULIA;
	const isMandelbrot = fractalType === FRACTAL_TYPE_MANDELBROT;
	const isShip = fractalType === FRACTAL_TYPE_BURNING_SHIP;
	const isMandala = fractalType === FRACTAL_TYPE_MANDALA;
	const isAnalytic = isJulia || isMandelbrot;
	const isFolded = isShip || isMandala;
	const isQuadratic = exponent === 2;
	// Julia and Mandala iterate from z0 = pixel, so the delta seeds z; Mandelbrot and
	// Burning Ship iterate from the critical point with c = pixel, so it seeds c.
	const deltaSeedsZ = isJulia || isMandala;
	const hasDeltaC = !deltaSeedsZ;
	const useBLA = isAnalytic && isQuadratic;
	const hasDerivative = isAnalytic && isQuadratic;
	const useCycleDetection = !useBLA;
	const interiorArg = isMandelbrot && isQuadratic ? 'INTERIOR_FLAT' : 'minMagSq';

	const blaDefines = useBLA
		? `#define BLA_BASE_CHUNK_SIZE ${BLA_BASE_CHUNK_SIZE}
#define BLA_MAX_LEVELS ${BLA_MAX_LEVELS}
#define BLA_LEVEL_STRIDE ${BLA_LEVEL_STRIDE}
#define BLA_TEXTURE_WIDTH ${BLA_TEXTURE_WIDTH}
`
		: '';

	const blaUniforms = useBLA
		? `// Hierarchical BLA (Bivariate Linear Approximation) table. Each level doubles
// the skip length from BLA_BASE_CHUNK_SIZE; the shader tries largest first and
// falls back to scalar perturbation when validity rejects a pixel.
// Two RGBA32F texels per level/position:
//   texel 0: [A.x, A.y, A_scaleExp, validityRsqLog2]
//   texel 1: [B.x, B.y, B_scaleExp, _unused_]
uniform sampler2D u_blaTable;
uniform sampler2D u_visualPrefixTexture;
`
		: '';

	const derivativeHelpers = hasDerivative
		? `
void rescaleDerivative(inout vec2 derivative, inout float logOffset) {
	float derivMagSq = dot(derivative, derivative);
	if (isFiniteFloat(derivMagSq) && derivMagSq > DERIVATIVE_RESCALE_TRIGGER_SQ) {
		derivative *= DERIVATIVE_RESCALE_FACTOR;
		logOffset += DERIVATIVE_RESCALE_LOG;
	}
}
`
		: '';

	const blaHelpers = useBLA
		? `
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

// (1 - STRIPE_EWMA_ALPHA)^chunkSize per BLA level: how much of the pixel's running
// stripe EWMA survives a skipped chunk. The remainder comes from the reference's
// prefix EWMA — exact, because the EWMA recurrence is linear. These are constants of
// the fixed chunk sizes and the fixed alpha, baked once per variant (zoom never
// recompiles anything).
const float BLA_STRIPE_EWMA_CHUNK_DECAY[BLA_MAX_LEVELS] = float[](${Array.from(
				{ length: BLA_MAX_LEVELS },
				(_, level) => {
					const decay = Math.pow(1 - STRIPE_EWMA_ALPHA, BLA_BASE_CHUNK_SIZE << level);
					return decay < 1e-30 ? '0.0' : decay.toExponential(8);
				},
			).join(', ')});
`
		: '';

	// The proven quadratic BLA fast path, with the Julia/Mandelbrot distinction baked.
	const blaBlock = useBLA
		? `
		bool usedBLA = false;
		for (int blaLevel = BLA_MAX_LEVELS - 1; blaLevel >= 0; blaLevel--) {
			int blaChunkSize = BLA_BASE_CHUNK_SIZE << blaLevel;
			// Leave at least one orbit sample for the scalar path so the reference-end
			// rebase below always gets a chance to run.
			if (k + blaChunkSize >= orbitLength - 1 || j + blaChunkSize - 1 > u_iterations) continue;

			vec4 blaA, blaB;
			getBLA(blaLevel, k, blaA, blaB);
			float dzMagSq = dx * dx + dy * dy;
			float dzLogMagSq = dzMagSq > 0.0 ? log2(dzMagSq) + 2.0 * float(q) : -1.0e30;
${
	isMandelbrot
		? `			float dcMagSq = baseDeltaX * baseDeltaX + baseDeltaY * baseDeltaY;
			float dcLogMagSq = dcMagSq > 0.0 ? log2(dcMagSq) + 2.0 * float(cq) : -1.0e30;
			float validityLogMagSq = max(dzLogMagSq, dcLogMagSq);`
		: `			float validityLogMagSq = dzLogMagSq;`
}
			// BLA validity is in absolute terms and bounds max(|dz|, |dc|).
			if (validityLogMagSq < blaA.w) {
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

${
	isMandelbrot
		? `				vec2 bMantissa = blaB.xy;
				int bExp = int(blaB.z);
				float bDx = bMantissa.x * baseDeltaX - bMantissa.y * baseDeltaY;
				float bDy = bMantissa.x * baseDeltaY + bMantissa.y * baseDeltaX;
				int bTermExp = bExp + cq;
				newQ = max(aTermExp, bTermExp);
				float aScale = downscaleToExponent(aTermExp, newQ);
				float bScale = downscaleToExponent(bTermExp, newQ);
				newDx = aDx * aScale + bDx * bScale;
				newDy = aDy * aScale + bDy * bScale;`
		: `				newDx = aDx;
				newDy = aDy;`
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
				if (isFiniteFloat(chunkZMagSq) && chunkZMagSq < u_escapeRadius * u_escapeRadius) {
					vec4 prefixBefore = getVisualPrefix(k);
					vec4 prefixAfter = getVisualPrefix(k + blaChunkSize);

					// Keep visual accumulators continuous across the BLA validity
					// boundary. The reference samples are a good approximation exactly
					// where BLA is valid because perturbations are small by definition.
					float chunkDecay = BLA_STRIPE_EWMA_CHUNK_DECAY[blaLevel];
					stripeEwma = stripeEwma * chunkDecay + (prefixAfter.y - prefixBefore.y * chunkDecay);
					previousStripeEwma = stripeEwma;
					// Reference running-min |Z|² across the skipped chunk.
					minMagSq = min(minMagSq, prefixAfter.w);
					detailSamples += blaChunkSize;

${
	isJulia
		? `					derivative = cmul(aMantissa, derivative);
					derivativeLogOffset += float(aExp) * LOG_2;`
		: `					vec2 aDerivative = cmul(aMantissa, derivative);
					float aLogScale = derivativeLogOffset + float(aExp) * LOG_2;
					float bLogScale = float(bExp) * LOG_2;
					float commonLogScale = max(aLogScale, bLogScale);
					float aDerivativeScale = exp(clamp(aLogScale - commonLogScale, -80.0, 0.0));
					float bDerivativeScale = exp(clamp(bLogScale - commonLogScale, -80.0, 0.0));
					derivative = aDerivative * aDerivativeScale + bMantissa * bDerivativeScale;
					derivativeLogOffset = commonLogScale;`
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
`
		: '';

	// Scalar delta step per variant. Each branch assigns dx, dy, q (pre-normalize).
	let scalarStep;
	if (isAnalytic && isQuadratic) {
		scalarStep = `			float previousReferenceScale = safeExp2(float(orbitScalePrev));
			vec2 previousZ = orbitCurrent.xy * previousReferenceScale + S * vec2(dx, dy);
			derivative = cmul(vec2(2.0 * previousZ.x, 2.0 * previousZ.y), derivative)${isMandelbrot ? ' + vec2(1.0, 0.0)' : ''};
			rescaleDerivative(derivative, derivativeLogOffset);

			vec2 linearTerm = vec2(
				2.0 * orbitCurrent.x * dx - 2.0 * orbitCurrent.y * dy,
				2.0 * orbitCurrent.x * dy + 2.0 * orbitCurrent.y * dx
			);
			vec2 squareTerm = vec2(dx * dx - dy * dy, 2.0 * dx * dy);
			int linearExp = q + orbitScalePrev;
			int squareExp = q + q;
			int targetQ = max(linearExp, squareExp);
${hasDeltaC ? '			targetQ = max(targetQ, cq);\n' : ''}			float linearScale = downscaleToExponent(linearExp, targetQ);
			float squareScale = downscaleToExponent(squareExp, targetQ);
			vec2 nextDelta = linearTerm * linearScale + squareTerm * squareScale;
${hasDeltaC ? '			nextDelta += vec2(baseDeltaX, baseDeltaY) * downscaleToExponent(cq, targetQ);\n' : ''}			dx = nextDelta.x;
			dy = nextDelta.y;
			q = targetQ;`;
	} else if (isAnalytic) {
		scalarStep = `			// z^${exponent} perturbation: δ' = Σ_{k=1..${exponent}} C(${exponent},k) Z^(${exponent}−k) δ^k${hasDeltaC ? ' + δc' : ''},
			// unrolled at generation time with literal binomial coefficients.
			${glslBinomialPerturbation(exponent, {
				baseExpr: 'orbitCurrent.xy',
				deltaExpr: 'vec2(dx, dy)',
				baseExpVar: 'orbitScalePrev',
				deltaExpVar: 'q',
				hasDeltaC,
			})}`;
	} else if (isQuadratic) {
		scalarStep = `			// Folded quadratic step. The reference iterates
			//   X' = X² − Y² + cx,  Y' = 2|X·Y| + cy
			// so with pixel delta δ = S·d the recurrence is
			//   δx' = 2(X·δx − Y·δy) + δx² − δy² ${isShip ? '+ δcx' : ''}
			//   δy' = 2·diffabs(X·Y, t) ${isShip ? '+ δcy' : ''},  t = X·δy + Y·δx + δx·δy
			// with diffabs(a, t) = |a + t| − |a|, carried in mantissa/exponent form.
			int linearExp = q + orbitScalePrev;
			int squareExp = q + q;

			float linearMantR = 2.0 * (orbitCurrent.x * dx - orbitCurrent.y * dy);
			float squareMantR = dx * dx - dy * dy;
			int realExp = max(linearExp, squareExp);
${isShip ? '			realExp = max(realExp, cq);\n' : ''}			float newDx = linearMantR * downscaleToExponent(linearExp, realExp)
				+ squareMantR * downscaleToExponent(squareExp, realExp);
${isShip ? '			newDx += baseDeltaX * downscaleToExponent(cq, realExp);\n' : ''}
			// diffabs branches on which side of the fold line a + t lands.
			float aMant = orbitCurrent.x * orbitCurrent.y;
			int aExp = orbitScalePrev + orbitScalePrev;
			int tExp = max(linearExp, squareExp);
			float tMant = (orbitCurrent.x * dy + orbitCurrent.y * dx) * downscaleToExponent(linearExp, tExp)
				+ dx * dy * downscaleToExponent(squareExp, tExp);
			int sumExp = max(aExp, tExp);
			float sumMant = aMant * downscaleToExponent(aExp, sumExp) + tMant * downscaleToExponent(tExp, sumExp);
			float dabsMant;
			int dabsExp;
			if (aMant >= 0.0 ? sumMant >= 0.0 : sumMant <= 0.0) {
				// Same side of the fold: |a + t| − |a| = ±t.
				dabsMant = aMant >= 0.0 ? tMant : -tMant;
				dabsExp = tExp;
			} else {
				// Crossed the fold: |a + t| − |a| = ∓(2a + t).
				dabsExp = max(aExp + 1, tExp);
				float crossMant = aMant * downscaleToExponent(aExp + 1, dabsExp)
					+ tMant * downscaleToExponent(tExp, dabsExp);
				dabsMant = aMant >= 0.0 ? -crossMant : crossMant;
			}
			int imagExp = dabsExp + 1; // δy' = 2·diffabs — the ×2 rides the exponent.
			float newDy = dabsMant;
${
	isShip
		? `			int combinedExp = max(imagExp, cq);
			newDy = newDy * downscaleToExponent(imagExp, combinedExp)
				+ baseDeltaY * downscaleToExponent(cq, combinedExp);
			imagExp = combinedExp;
`
		: ''
}
			int targetQ = max(realExp, imagExp);
			dx = newDx * downscaleToExponent(realExp, targetQ);
			dy = newDy * downscaleToExponent(imagExp, targetQ);
			q = targetQ;`;
	} else {
		scalarStep = `			// Folded power-${exponent} step: z' = (|x| + i|y|)^${exponent} + c. Per-component
			// diffabs gives the exact delta of the fold, ω = (|X+δx|−|X|, |Y+δy|−|Y|),
			// then the same binomial expansion as the analytic case applies to
			// (W + ω)^${exponent} − W^${exponent} with W = (|X|, |Y|).
			${glslComponentDiffabs('U', 'orbitCurrent.x', 'dx')}
			${glslComponentDiffabs('V', 'orbitCurrent.y', 'dy')}
			int qw = max(UExp, VExp);
			vec2 omega = vec2(UMant * downscaleToExponent(UExp, qw), VMant * downscaleToExponent(VExp, qw));
			vec2 wAbs = abs(orbitCurrent.xy);
			${glslBinomialPerturbation(exponent, {
				baseExpr: 'wAbs',
				deltaExpr: 'omega',
				baseExpVar: 'orbitScalePrev',
				deltaExpVar: 'qw',
				hasDeltaC: isShip,
			})}`;
	}

	const cycleCheckBlock = useCycleDetection
		? `
		// Brent-style cycle detection (no BLA in this variant, so every iteration runs
		// scalar and interior pixels would otherwise burn the whole budget). Exact
		// float32 equality of the reconstructed z keeps false positives out.
		if (all(equal(vec2(fx, fy), tortoise))) {
			break;
		}
		if (j == nextTortoiseUpdate) {
			tortoise = vec2(fx, fy);
			nextTortoiseUpdate *= 2;
		}
`
		: '';

	const escapedMetric = hasDerivative
		? `FragColor = buildDistanceMetric(
			smoothIters,
			finalZ,
			finalDerivative,
			finalDerivativeLogOffset,
			stripeEwma,
			previousStripeEwma,
			stripeSamples,
			stripeMagSq,
			detailSamples,
			logViewRadius,
			-1.0
		);`
		: `// Same escape metric the standard shader uses for these formulas: no
		// derivative-based distance estimate, detail brightness from the orbit average.
		FragColor = buildMetric(
			smoothIters,
			detailTotal,
			detailSamples,
			stripeEwma,
			previousStripeEwma,
			stripeSamples,
			stripeMagSq,
			1.0
		);`;

	const stripeRunoff = `		int stripeSamples = detailSamples;
		float stripeMagSq = dot(finalZ, finalZ);
		for (int r = 0; r < STRIPE_RUNOFF_LIMIT; r++) {
			if (!isFiniteFloat(stripeMagSq) || stripeMagSq > STRIPE_AVERAGE_ESCAPE_RADIUS * STRIPE_AVERAGE_ESCAPE_RADIUS) {
				break;
			}
			if (k >= orbitLength - 1) break;
			int orbitScalePrev = int(orbitCurrent.z);
			{
${scalarStep}
			}
			normalizePerturbation(dx, dy, q);
			S = safeExp2(float(q));

			k += 1;
			vec3 orbitNext = getOrbit(k);
			float referenceScale = safeExp2(orbitNext.z);
			float fx = orbitNext.x * referenceScale + S * dx;
			float fy = orbitNext.y * referenceScale + S * dy;
			float runoffMagSq = fx * fx + fy * fy;
			if (!isFiniteFloat(runoffMagSq)) break;
			stripeMagSq = runoffMagSq;
			previousStripeEwma = stripeEwma;
			stripeEwma = mix(stripeEwma, stripeAverageAddend(vec2(fx, fy)), STRIPE_EWMA_ALPHA);
			stripeSamples += 1;
			orbitCurrent = orbitNext;
		}`;

	return `#version 300 es
precision highp float;

#define FRACTAL_TYPE ${fractalType}
#define EXPONENT ${exponent}
#define N_COLORS ${N_COLORS}
#define ORBIT_TEXTURE_SIZE ${ORBIT_TEXTURE_SIZE}
#define BAILOUT_PERTURBATION_DELTA_SQ 1.0e6
${
	hasDerivative
		? `// |dz| grows as ~prod(2*|Z|) and overflows float32 in deep zoom, so we carry it as a
// (mantissa, log-offset) pair: log|dz| = log(length(mantissa)) + logOffset.
#define DERIVATIVE_RESCALE_TRIGGER_SQ 1.0e30
#define DERIVATIVE_RESCALE_FACTOR 1.0e-15
#define DERIVATIVE_RESCALE_LOG 34.538776394910684
`
		: ''
}${blaDefines}
uniform sampler2D u_orbitTexture;
${blaUniforms}uniform vec2 u_resolution;
uniform int u_iterations;
uniform int u_orbitLength;
uniform float u_radiusMantissa;
uniform int u_radiusExponent;
uniform vec2 u_referenceOffset;
uniform float u_escapeRadius;
uniform float u_logEscapeRadius;

out vec4 FragColor;

const float LOG_2 = 0.6931471805599453;
${GLSL_PACK_CONSTANTS}${GLSL_IS_FINITE}
float safeExp2(float exponent) {
	return exp2(clamp(exponent, -126.0, 126.0));
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
${derivativeHelpers}
vec3 getOrbit(int i) {
	int row = i / ORBIT_TEXTURE_SIZE;
	int col = i - row * ORBIT_TEXTURE_SIZE;
	return texelFetch(u_orbitTexture, ivec2(col, row), 0).rgb;
}
${blaHelpers}${GLSL_METRIC_SHARED}
void main() {
	// Branchless aspect-ratio handling: one axis is unit-1, the other extends to the aspect ratio.
	vec2 pixelScale = u_resolution / min(u_resolution.x, u_resolution.y);
	vec2 delta = (gl_FragCoord.xy / u_resolution * 2.0 - 1.0) * pixelScale;

	int orbitLength = max(u_orbitLength, 1);
	int cq = u_radiusExponent;
	int q = cq;
	float S = safeExp2(float(q));
	float baseDeltaX = (delta.x + u_referenceOffset.x) * u_radiusMantissa;
${
	isShip
		? `	// The standard shader samples Burning Ship's parameter plane y-flipped
	// (coord *= vec2(1, -1)). The reference orbit conjugates its center to match
	// (gmpUtils.computeReferenceData), so the per-pixel delta needs the same flip.
	float baseDeltaY = -(delta.y + u_referenceOffset.y) * u_radiusMantissa;
`
		: `	float baseDeltaY = (delta.y + u_referenceOffset.y) * u_radiusMantissa;
`
}	float dx = ${deltaSeedsZ ? 'baseDeltaX' : '0.0'};
	float dy = ${deltaSeedsZ ? 'baseDeltaY' : '0.0'};

	int k = 0;
	int j = 0;
	vec3 orbit0 = getOrbit(0);
	vec3 orbitCurrent = orbit0;
	float smoothIters = 0.0;
	float stripeEwma = 0.5;
	float previousStripeEwma = 0.5;
${hasDerivative ? '' : '	float detailTotal = 0.0;\n'}	float minMagSq = 1.0e30;
${
	useCycleDetection
		? `	vec2 tortoise = vec2(1.0e30);
	int nextTortoiseUpdate = 8;
`
		: ''
}	int detailSamples = 0;
	bool escaped = false;
${
	hasDerivative
		? `	vec2 derivative = ${isJulia ? 'vec2(1.0, 0.0)' : 'vec2(0.0)'};
	float derivativeLogOffset = 0.0;
	vec2 finalDerivative = derivative;
	float finalDerivativeLogOffset = 0.0;
	float logViewRadius = log(max(abs(u_radiusMantissa), 1e-30)) + float(u_radiusExponent) * log(2.0);
`
		: ''
}	vec2 finalZ = vec2(0.0);

	for (int i = 0; i < u_iterations; i++) {
		// j tracks the iteration count; cap against u_iterations.
		if (j >= u_iterations || k >= orbitLength - 1) break;

		j += 1;
${blaBlock}
		int orbitScalePrev = int(orbitCurrent.z);
		{
${scalarStep}
		}
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
${
	hasDerivative
		? `			finalDerivative = derivative;
			finalDerivativeLogOffset = derivativeLogOffset;
`
		: '			detailTotal += orbitDetailValue(finalZ);\n'
}			previousStripeEwma = stripeEwma;
			stripeEwma = mix(stripeEwma, stripeAverageAddend(finalZ), STRIPE_EWMA_ALPHA);
			minMagSq = min(minMagSq, magnitudeSq);
			detailSamples += 1;
		}

		if (!finiteMagnitude) {
			smoothIters = float(j);
			escaped = true;
			orbitCurrent = orbitNext;
			break;
		}

		if (magnitudeSq > u_escapeRadius * u_escapeRadius) {
			// j was incremented at the top of the loop body; pass j-1 so this matches
			// the standard shader (which passes its pre-increment loop index) and the
			// palette doesn't shift one band at the standard/deep handoff.
			smoothIters = smoothEscape(j - 1, sqrt(magnitudeSq));
			escaped = true;
			orbitCurrent = orbitNext;
			break;
		}
${cycleCheckBlock}
		float perturbationDeltaSq = dx * dx + dy * dy;
		if (isFiniteFloat(perturbationDeltaSq) && perturbationDeltaSq > BAILOUT_PERTURBATION_DELTA_SQ) {
			dx *= 0.5;
			dy *= 0.5;
			q += 1;
			S = safeExp2(float(q));
		}

		// Iteration-extension rebase: when the reference orbit runs out, fold the current
		// full z back into a fresh perturbation from orbit[0]. Mandelbrot's and Burning
		// Ship's orbit[0] = 0, Julia's and Mandala's = the reference center; the fold math
		// (dx, dy = fx - orbit0.xy * scale) generalises to all four. With long-orbit
		// references (the normal case after the recent recompute headroom changes) this
		// never fires. It only fires when the reference escaped early — in that case the
		// z0-seeded formulas would otherwise show a solid view, since without the fold
		// every still-unescaped pixel returns interiorMetric(). Post-rebase
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
${stripeRunoff}
		${escapedMetric}
	} else {
		// Quadratic Mandelbrot keeps the flat interior to match the standard shader's
		// cardioid/bulb early-out look; everything else shades by min |z|.
		FragColor = interiorMetric(${interiorArg});
	}
}
`;
}
