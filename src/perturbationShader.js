export function generatePerturbationShader(maxIterations = 8192) {
	return `#version 300 es
precision highp float;

#define FRACTAL_TYPE_JULIA 0
#define FRACTAL_TYPE_MANDELBROT 1
#define MAX_ITERATIONS ${maxIterations}

uniform sampler2D u_orbitTexture;
uniform vec2 u_resolution;
uniform int u_iterations;
uniform int u_orbitLength;
uniform int u_fractalType;
uniform float u_radiusMantissa;
uniform int u_radiusExponent;
uniform vec2 u_referenceOffset;
uniform int u_transitionSmoothing;
uniform float u_escapeRadius;
uniform float u_logEscapeRadius;

out vec4 FragColor;

float safeExp2(float exponent) {
	return exp2(clamp(exponent, -126.0, 126.0));
}

bool isFiniteFloat(float value) {
	return !isnan(value) && !isinf(value);
}

vec2 cmul(vec2 a, vec2 b) {
	return vec2(a.x * b.x - a.y * b.y, a.x * b.y + b.x * a.y);
}

float getOrbitX(int i) {
	int index = i * 3;
	int row = index / 1024;
	int col = index % 1024;
	return texelFetch(u_orbitTexture, ivec2(col, row), 0).r;
}

float getOrbitY(int i) {
	int index = i * 3 + 1;
	int row = index / 1024;
	int col = index % 1024;
	return texelFetch(u_orbitTexture, ivec2(col, row), 0).r;
}

float getOrbitScale(int i) {
	int index = i * 3 + 2;
	int row = index / 1024;
	int col = index % 1024;
	return texelFetch(u_orbitTexture, ivec2(col, row), 0).r;
}

float smoothEscape(int iteration, float magnitude) {
	float logMag = log(magnitude);
	float logRatio = logMag / max(u_logEscapeRadius, 1e-6);
	float nu = log(logRatio) / log(2.0);
	return float(iteration) + float(u_transitionSmoothing) * (1.0 - nu);
}

float orbitDetailValue(vec2 z) {
	return 1.0 / (1.0 + dot(z, z));
}

vec4 buildMetric(float smoothIters, float detailTotal, int detailSamples, float escaped) {
	float detailAverage = detailSamples > 0 ? detailTotal / float(detailSamples) : 0.5;
	float detailWeight = escaped > 0.5 ? smoothstep(3.0, 24.0, float(detailSamples)) : 1.0;
	return vec4(smoothIters, mix(0.5, detailAverage, detailWeight), detailWeight, escaped);
}

float distanceEstimateDetail(vec2 z, vec2 dz, float logViewRadius) {
	float mag = length(z);
	float derivativeMag = length(dz);
	if (!isFiniteFloat(mag) || !isFiniteFloat(derivativeMag) || mag <= 1.0 || derivativeMag <= 1e-20) {
		return 0.0;
	}

	float logDistance = log(0.5 * mag * max(log(mag), 1e-6)) - log(derivativeMag);
	float screenDistance = exp(clamp(logDistance - logViewRadius, -30.0, 30.0));
	if (!isFiniteFloat(screenDistance)) {
		return 0.0;
	}

	return clamp(1.0 - smoothstep(0.003, 0.12, screenDistance), 0.0, 1.0);
}

vec4 buildDistanceMetric(float smoothIters, vec2 z, vec2 dz, int detailSamples, float logViewRadius) {
	float detail = distanceEstimateDetail(z, dz, logViewRadius);
	float detailWeight = smoothstep(4.0, 32.0, float(detailSamples));
	return vec4(smoothIters, 0.5 + 0.5 * detail, detailWeight, 1.0);
}

void main() {
	vec2 delta = gl_FragCoord.xy / u_resolution * 2.0 - 1.0;
	float aspectRatio = u_resolution.x / u_resolution.y;
	if (aspectRatio > 1.0) {
		delta.x *= aspectRatio;
	} else {
		delta.y /= aspectRatio;
	}

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
	float x = getOrbitX(0);
	float y = getOrbitY(0);
	float smoothIters = float(u_iterations);
	float detailTotal = 0.0;
	int detailSamples = 0;
	float escaped = 0.0;
	vec2 derivative = isJulia ? vec2(1.0, 0.0) : vec2(0.0);
	vec2 finalZ = vec2(0.0);
	vec2 finalDerivative = derivative;
	float logViewRadius = log(max(abs(u_radiusMantissa), 1e-30)) + float(u_radiusExponent) * log(2.0);

	for (int i = 0; i < MAX_ITERATIONS; i++) {
		if (i >= u_iterations || k >= orbitLength - 1) {
			break;
		}

		j += 1;
		float orbitScalePrev = getOrbitScale(k);
		float deltaScale = safeExp2(float(cq - q) - orbitScalePrev);
		float dcx = isJulia ? 0.0 : baseDeltaX * deltaScale;
		float dcy = isJulia ? 0.0 : baseDeltaY * deltaScale;
		float previousReferenceScale = safeExp2(orbitScalePrev);
		vec2 previousZ = vec2(x, y) * previousReferenceScale + S * vec2(dx, dy);
		derivative = cmul(vec2(2.0 * previousZ.x, 2.0 * previousZ.y), derivative);
		if (!isJulia) {
			derivative += vec2(1.0, 0.0);
		}

		float unS = safeExp2(float(q) - orbitScalePrev);
		float tx = 2.0 * x * dx - 2.0 * y * dy + unS * dx * dx - unS * dy * dy + dcx;
		dy = 2.0 * x * dy + 2.0 * y * dx + unS * 2.0 * dx * dy + dcy;
		dx = tx;

		q += int(orbitScalePrev);
		S = safeExp2(float(q));

		k += 1;
		x = getOrbitX(k);
		y = getOrbitY(k);

		float orbitScale = getOrbitScale(k);
		float referenceScale = safeExp2(orbitScale);
		float fx = x * referenceScale + S * dx;
		float fy = y * referenceScale + S * dy;
		float magnitudeSq = fx * fx + fy * fy;
		float perturbationMagnitudeSq = S * S * (dx * dx + dy * dy);
		bool finiteMagnitude = isFiniteFloat(magnitudeSq);
		bool finitePerturbation = isFiniteFloat(perturbationMagnitudeSq);

		if (finiteMagnitude) {
			finalZ = vec2(fx, fy);
			finalDerivative = derivative;
			detailTotal += orbitDetailValue(finalZ);
			detailSamples += 1;
		}

		if (!finiteMagnitude) {
			smoothIters = float(j);
			escaped = 1.0;
			break;
		}

		if (magnitudeSq > u_escapeRadius * u_escapeRadius) {
			smoothIters = smoothEscape(j, sqrt(magnitudeSq));
			escaped = 1.0;
			break;
		}

		float perturbationDeltaSq = dx * dx + dy * dy;
		if (isFiniteFloat(perturbationDeltaSq) && perturbationDeltaSq > 1000000.0) {
			dx *= 0.5;
			dy *= 0.5;
			q += 1;
			S = safeExp2(float(q));
		}

		// mathr-style rebasing: rebase when |Z + z| < |z|.
		if (finiteMagnitude && finitePerturbation && magnitudeSq < perturbationMagnitudeSq) {
			float referenceStartScale = safeExp2(getOrbitScale(0));
			dx = fx - getOrbitX(0) * referenceStartScale;
			dy = fy - getOrbitY(0) * referenceStartScale;
			k = 0;
			q = 0;
			S = 1.0;
			x = getOrbitX(0);
			y = getOrbitY(0);
		}
	}

	if (escaped > 0.5) {
		FragColor = buildDistanceMetric(smoothIters, finalZ, finalDerivative, detailSamples, logViewRadius);
	} else {
		FragColor = buildMetric(smoothIters, detailTotal, detailSamples, escaped);
	}
}
`;
}
