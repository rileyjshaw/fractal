import assert from 'node:assert/strict';
import test from 'node:test';

import { GMPUtils } from '../src/gmpUtils.js';

// Integration coverage for computeReferenceData's seeding and recurrence per fractal
// type, validated against direct double iteration at shallow (double-safe) centers.
// Orbit entries store (xMantissa, yMantissa, scaleExponent) with a shared exponent.

function orbitEntry(orbit, i) {
	const scale = Math.pow(2, orbit[i * 3 + 2]);
	return [orbit[i * 3] * scale, orbit[i * 3 + 1] * scale];
}

function assertOrbitMatches(orbit, orbitLength, step, z0, steps) {
	let [x, y] = z0;
	for (let i = 0; i < Math.min(steps, orbitLength); i++) {
		const [ox, oy] = orbitEntry(orbit, i);
		const scale = Math.max(1, Math.abs(x), Math.abs(y));
		assert.ok(
			Math.abs(ox - x) <= 1e-6 * scale && Math.abs(oy - y) <= 1e-6 * scale,
			`orbit step ${i}: (${ox}, ${oy}) != (${x}, ${y})`,
		);
		[x, y] = step(x, y);
		if (x * x + y * y > 64 * 64) break;
	}
}

const gmp = new GMPUtils();
test.before(async () => {
	await gmp.init();
});

test('Mandelbrot reference orbit matches direct z² + c iteration', () => {
	const [cx, cy] = [-0.16, 0.61];
	const { orbit, orbitLength } = gmp.computeReferenceData('-0.16', '0.61', 64, { fractalType: 1 });
	assertOrbitMatches(orbit, orbitLength, (x, y) => [x * x - y * y + cx, 2 * x * y + cy], [0, 0], 64);
});

test('Julia reference orbit seeds z0 from the center with the fixed constant', () => {
	const [cx, cy] = [-0.71, -0.43];
	const { orbit, orbitLength } = gmp.computeReferenceData('0.21', '0.35', 64, {
		fractalType: 0,
		cReal: cx,
		cImaginary: cy,
	});
	assertOrbitMatches(orbit, orbitLength, (x, y) => [x * x - y * y + cx, 2 * x * y + cy], [0.21, 0.35], 64);
});

test('Burning Ship reference orbit conjugates the center and folds the imaginary part', () => {
	// View center (a, b) iterates at parameter (a, -b) — the standard shader samples the
	// ship's parameter plane y-flipped, and the deep path has to match it. The parameter
	// (-1.74, -0.025) has a bounded orbit; its unconjugated mirror escapes, so the length
	// check below fails if the conjugation is dropped.
	const [cx, cy] = [-1.74, -0.025];
	const { orbit, orbitLength } = gmp.computeReferenceData('-1.74', '0.025', 64, {
		fractalType: 2,
	});
	assert.equal(orbitLength, 64, 'expected the full non-escaping orbit');
	assertOrbitMatches(orbit, orbitLength, (x, y) => [x * x - y * y + cx, 2 * Math.abs(x * y) + cy], [0, 0], 64);
});

test('Mandala reference orbit seeds z0 from the center with the folded recurrence', () => {
	const [cx, cy] = [0.37, 0.06];
	const { orbit, orbitLength } = gmp.computeReferenceData('0.31', '-0.24', 64, {
		fractalType: 3,
		cReal: cx,
		cImaginary: cy,
	});
	assertOrbitMatches(orbit, orbitLength, (x, y) => [x * x - y * y + cx, 2 * Math.abs(x * y) + cy], [0.31, -0.24], 64);
});

function complexPow(x, y, n) {
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

test('power-3 Mandelbrot reference orbit matches direct z³ + c iteration', () => {
	const [cx, cy] = [0.2, 0.25];
	const { orbit, orbitLength } = gmp.computeReferenceData('0.2', '0.25', 64, { fractalType: 1, exponent: 3 });
	assert.equal(orbitLength, 64, 'expected the full non-escaping orbit');
	assertOrbitMatches(
		orbit,
		orbitLength,
		(x, y) => {
			const [px, py] = complexPow(x, y, 3);
			return [px + cx, py + cy];
		},
		[0, 0],
		64,
	);
});

test('power-3 Burning Ship reference orbit conjugates the center and folds before powering', () => {
	// Bounded power-3 ship parameter; view center is its conjugate.
	const [cx, cy] = [0.19963220214040311, -0.3864301515930384];
	const { orbit, orbitLength } = gmp.computeReferenceData('0.19963220214040311', '0.3864301515930384', 64, {
		fractalType: 2,
		exponent: 3,
	});
	assert.equal(orbitLength, 64, 'expected the full non-escaping orbit');
	assertOrbitMatches(
		orbit,
		orbitLength,
		(x, y) => {
			const [px, py] = complexPow(Math.abs(x), Math.abs(y), 3);
			return [px + cx, py + cy];
		},
		[0, 0],
		64,
	);
});
