import assert from 'node:assert/strict';
import test from 'node:test';

// Double-precision mirror of the folded (Burning Ship / Mandala) perturbation math in
// perturbationShader.js. The shader carries deltas in mantissa/exponent form; here the
// same recurrence runs in plain doubles so it can be validated against direct iteration:
//
//   reference:  X' = X² − Y² + cx,  Y' = 2|X·Y| + cy
//   pixel:      z = Z + δ, c = C + δc
//   δx' = 2(X·δx − Y·δy) + δx² − δy² + δcx
//   δy' = 2·diffabs(X·Y, X·δy + Y·δx + δx·δy) + δcy
//
// diffabs(a, t) = |a + t| − |a| is exact (not a linearization), so the perturbed orbit
// must track the directly-iterated pixel orbit to double rounding error — including
// steps where the pixel crosses a fold line (sign(x·y) differs from the reference).

function foldedStep([x, y], [cx, cy]) {
	return [x * x - y * y + cx, 2 * Math.abs(x * y) + cy];
}

function diffabs(a, t) {
	if (a >= 0) {
		return a + t >= 0 ? t : -(2 * a + t);
	}
	return a + t > 0 ? 2 * a + t : -t;
}

function foldedPerturbationStep([X, Y], [dx, dy], [dcx, dcy]) {
	const nextDx = 2 * (X * dx - Y * dy) + dx * dx - dy * dy + dcx;
	const t = X * dy + Y * dx + dx * dy;
	const nextDy = 2 * diffabs(X * Y, t) + dcy;
	return [nextDx, nextDy];
}

// Runs both orbits side by side and asserts Z + δ matches the direct pixel orbit at
// every step until either orbit escapes. Returns how many fold-crossing steps were seen
// so tests can assert the interesting branch was actually exercised.
function assertPerturbationTracksDirect({ referenceZ0, referenceC, pixelZ0, pixelC, steps, tolerance = 1e-9 }) {
	let reference = [...referenceZ0];
	let pixel = [...pixelZ0];
	let delta = [pixel[0] - reference[0], pixel[1] - reference[1]];
	const deltaC = [pixelC[0] - referenceC[0], pixelC[1] - referenceC[1]];
	let foldCrossings = 0;

	for (let i = 0; i < steps; i++) {
		if (Math.sign(reference[0] * reference[1]) !== Math.sign(pixel[0] * pixel[1])) {
			foldCrossings += 1;
		}
		// The perturbation recurrence consumes the pre-step reference (X_n, Y_n).
		delta = foldedPerturbationStep(reference, delta, deltaC);
		reference = foldedStep(reference, referenceC);
		pixel = foldedStep(pixel, pixelC);
		if (Math.hypot(...pixel) > 64 || Math.hypot(...reference) > 64) break;

		const reconstructed = [reference[0] + delta[0], reference[1] + delta[1]];
		const scale = Math.max(1, Math.abs(pixel[0]), Math.abs(pixel[1]));
		assert.ok(
			Math.abs(reconstructed[0] - pixel[0]) <= tolerance * scale &&
				Math.abs(reconstructed[1] - pixel[1]) <= tolerance * scale,
			`step ${i}: reference + delta (${reconstructed}) != direct pixel orbit (${pixel})`,
		);
	}
	return foldCrossings;
}

test('Burning-Ship-style perturbation (delta in c) matches direct iteration', () => {
	// Bounded ship parameter off the real axis; the orbit survives the full test window.
	const referenceC = [-1.74, -0.025];
	const pixelC = [referenceC[0] + 3e-7, referenceC[1] - 2e-7];
	assertPerturbationTracksDirect({
		referenceZ0: [0, 0],
		referenceC,
		pixelZ0: [0, 0],
		pixelC,
		steps: 200,
	});
});

test('Mandala-style perturbation (delta in z0, shared constant) matches direct iteration', () => {
	const constant = [0.37, 0.06];
	const referenceZ0 = [0.31, -0.24];
	const pixelZ0 = [referenceZ0[0] - 4e-7, referenceZ0[1] + 6e-7];
	assertPerturbationTracksDirect({
		referenceZ0,
		referenceC: constant,
		pixelZ0,
		pixelC: constant,
		steps: 200,
	});
});

test('perturbation stays exact across fold-line crossings', () => {
	// A delta large enough that the pixel orbit lands on the other side of a fold line
	// (sign(x·y) flips relative to the reference) within a few steps. diffabs handles
	// this exactly, so tracking must not degrade.
	const referenceC = [-1.74, -0.025];
	const pixelC = [referenceC[0] + 2e-3, referenceC[1] + 1.5e-3];
	const foldCrossings = assertPerturbationTracksDirect({
		referenceZ0: [0, 0],
		referenceC,
		pixelZ0: [0, 0],
		pixelC,
		steps: 60,
		tolerance: 1e-7,
	});
	assert.ok(foldCrossings > 0, 'expected the pixel orbit to cross a fold line during the test');
});

// --- General exponent N: mirrors of the binomial perturbation the shader generator
// emits (perturbationShader.js glslBinomialPerturbation).
//   analytic: δ' = Σ_{k=1..N} C(N,k) Z^(N−k) δ^k + δc
//   folded:   same with base W = (|X|, |Y|) and delta ω = (diffabs(X,δx), diffabs(Y,δy))
// Both are exact (no linearization), so tracking must hold to rounding error.

function complexPow([x, y], n) {
	let px = x;
	let py = y;
	for (let i = 1; i < n; i++) {
		const nextX = px * x - py * y;
		const nextY = px * y + py * x;
		px = nextX;
		py = nextY;
	}
	return [px, py];
}

function complexMul([ax, ay], [bx, by]) {
	return [ax * bx - ay * by, ax * by + ay * bx];
}

function binomial(n, k) {
	let value = 1;
	for (let i = 1; i <= k; i++) {
		value = (value * (n - i + 1)) / i;
	}
	return value;
}

function binomialDelta(base, delta, n) {
	let acc = [0, 0];
	let deltaPow = [...delta];
	for (let k = 1; k <= n; k++) {
		if (k > 1) deltaPow = complexMul(deltaPow, delta);
		const term = n - k > 0 ? complexMul(complexPow(base, n - k), deltaPow) : deltaPow;
		const coefficient = binomial(n, k);
		acc = [acc[0] + coefficient * term[0], acc[1] + coefficient * term[1]];
	}
	return acc;
}

function analyticStepN(z, c, n) {
	const p = complexPow(z, n);
	return [p[0] + c[0], p[1] + c[1]];
}

function foldedStepN([x, y], c, n) {
	const p = complexPow([Math.abs(x), Math.abs(y)], n);
	return [p[0] + c[0], p[1] + c[1]];
}

function assertGeneralPerturbationTracksDirect({ step, perturb, referenceZ0, referenceC, pixelZ0, pixelC, steps }) {
	let reference = [...referenceZ0];
	let pixel = [...pixelZ0];
	let delta = [pixel[0] - reference[0], pixel[1] - reference[1]];
	const deltaC = [pixelC[0] - referenceC[0], pixelC[1] - referenceC[1]];
	let tracked = 0;

	for (let i = 0; i < steps; i++) {
		delta = perturb(reference, delta, deltaC);
		reference = step(reference, referenceC);
		pixel = step(pixel, pixelC);
		if (Math.hypot(...pixel) > 64 || Math.hypot(...reference) > 64) break;

		const reconstructed = [reference[0] + delta[0], reference[1] + delta[1]];
		const scale = Math.max(1, Math.abs(pixel[0]), Math.abs(pixel[1]));
		assert.ok(
			Math.abs(reconstructed[0] - pixel[0]) <= 1e-8 * scale &&
				Math.abs(reconstructed[1] - pixel[1]) <= 1e-8 * scale,
			`step ${i}: reference + delta (${reconstructed}) != direct pixel orbit (${pixel})`,
		);
		tracked += 1;
	}
	assert.ok(tracked >= 50, `expected at least 50 tracked steps, got ${tracked}`);
}

test('power-3 Mandelbrot-style perturbation (delta in c) matches direct iteration', () => {
	const n = 3;
	const referenceC = [0.2, 0.25];
	assertGeneralPerturbationTracksDirect({
		step: (z, c) => analyticStepN(z, c, n),
		perturb: (Z, delta, deltaC) => {
			const d = binomialDelta(Z, delta, n);
			return [d[0] + deltaC[0], d[1] + deltaC[1]];
		},
		referenceZ0: [0, 0],
		referenceC,
		pixelZ0: [0, 0],
		pixelC: [referenceC[0] + 3e-7, referenceC[1] - 2e-7],
		steps: 200,
	});
});

test('power-5 Julia-style perturbation (delta in z0) matches direct iteration', () => {
	const n = 5;
	const constant = [0.1, 0.1];
	const referenceZ0 = [0.5, 0.4];
	assertGeneralPerturbationTracksDirect({
		step: (z, c) => analyticStepN(z, c, n),
		perturb: (Z, delta) => binomialDelta(Z, delta, n),
		referenceZ0,
		referenceC: constant,
		pixelZ0: [referenceZ0[0] - 4e-7, referenceZ0[1] + 6e-7],
		pixelC: constant,
		steps: 200,
	});
});

function foldedBinomialDelta(Z, delta, deltaC, n) {
	const omega = [diffabs(Z[0], delta[0]), diffabs(Z[1], delta[1])];
	const base = [Math.abs(Z[0]), Math.abs(Z[1])];
	const d = binomialDelta(base, omega, n);
	return [d[0] + deltaC[0], d[1] + deltaC[1]];
}

test('power-3 folded perturbation (Burning-Ship-style) matches direct iteration', () => {
	const n = 3;
	const referenceC = [0.19963220214040311, -0.3864301515930384];
	assertGeneralPerturbationTracksDirect({
		step: (z, c) => foldedStepN(z, c, n),
		perturb: (Z, delta, deltaC) => foldedBinomialDelta(Z, delta, deltaC, n),
		referenceZ0: [0, 0],
		referenceC,
		pixelZ0: [0, 0],
		pixelC: [referenceC[0] + 3e-7, referenceC[1] - 2e-7],
		steps: 200,
	});
});

test('power-4 folded perturbation (Mandala-style, delta in z0) matches direct iteration', () => {
	const n = 4;
	const constant = [0.18, -0.22];
	const referenceZ0 = [0.4478572596581021, -0.06581842725367815];
	assertGeneralPerturbationTracksDirect({
		step: (z, c) => foldedStepN(z, c, n),
		perturb: (Z, delta) => foldedBinomialDelta(Z, delta, [0, 0], n),
		referenceZ0,
		referenceC: constant,
		pixelZ0: [referenceZ0[0] + 5e-7, referenceZ0[1] - 3e-7],
		pixelC: constant,
		steps: 200,
	});
});

test('power-3 folded perturbation stays exact across fold-line crossings', () => {
	const n = 3;
	const referenceC = [0.19963220214040311, -0.3864301515930384];
	// Offset chosen (numerically) so the pixel orbit crosses component fold lines
	// several times within the tracked window while both orbits stay bounded.
	const pixelC = [referenceC[0] - 0.009428742876781913, referenceC[1] - 0.01744381602651111];
	let reference = [0, 0];
	let pixel = [0, 0];
	let delta = [0, 0];
	const deltaC = [pixelC[0] - referenceC[0], pixelC[1] - referenceC[1]];
	let foldCrossings = 0;

	for (let i = 0; i < 60; i++) {
		if (Math.sign(reference[0]) !== Math.sign(pixel[0]) || Math.sign(reference[1]) !== Math.sign(pixel[1])) {
			foldCrossings += 1;
		}
		delta = foldedBinomialDelta(reference, delta, deltaC, n);
		reference = foldedStepN(reference, referenceC, n);
		pixel = foldedStepN(pixel, pixelC, n);
		if (Math.hypot(...pixel) > 64 || Math.hypot(...reference) > 64) break;

		const reconstructed = [reference[0] + delta[0], reference[1] + delta[1]];
		const scale = Math.max(1, Math.abs(pixel[0]), Math.abs(pixel[1]));
		assert.ok(
			Math.abs(reconstructed[0] - pixel[0]) <= 1e-6 * scale &&
				Math.abs(reconstructed[1] - pixel[1]) <= 1e-6 * scale,
			`step ${i}: reference + delta (${reconstructed}) != direct pixel orbit (${pixel})`,
		);
	}
	assert.ok(foldCrossings > 0, 'expected the pixel orbit to cross a fold line during the test');
});
