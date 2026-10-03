import test from 'node:test';
import assert from 'node:assert/strict';
import { init } from 'gmp-wasm';
import { DeepZoomManager } from '../src/deepZoom.js';
import { REFERENCE_ORBIT_RUNOFF } from '../src/shaderCommon.js';

// Main-cardioid Julia set: an attracting fixed point inside, so interior pixels run
// the whole budget. The view sits 0.3 radii from the repelling fixed point beta.
const [cReal, cImaginary] = [0.3274, 0.1945];
const radius = '1e-40';
const budget = 2048;
const options = { fractalType: 0, exponent: 2, cReal, cImaginary, radiusExact: radius };
const manager = new DeepZoomManager();
let center;

// beta = (1 + sqrt(1 - 4c)) / 2, computed independently of the Newton search.
async function repellingFixedPoint() {
	const { getContext } = await init();
	const g = getContext({ precisionBits: 1536 });
	try {
		const a = g.Float(1).sub(g.Float(cReal).mul(4)),
			b = g.Float(cImaginary).mul(-4);
		const modulus = a.mul(a).add(b.mul(b)).sqrt();
		return [
			modulus.add(a).div(2).sqrt().add(1).div(2).toString(),
			modulus
				.sub(a)
				.div(2)
				.sqrt()
				.mul(Math.sign(Number(b.toString())))
				.div(2)
				.toString(),
		];
	} finally {
		g.destroy();
	}
}

// Smooth escape count as metric.js and the shaders encode it (escape radius 2).
function smoothEscape(iteration, magnitude) {
	return iteration - Math.max(-1, Math.min(2, Math.log2(Math.max(Math.log(magnitude) / Math.log(2), 1e-6))));
}

function orbitPoint(orbit, i) {
	const scale = Math.pow(2, orbit[i * 3 + 2]);
	return [orbit[i * 3] * scale, orbit[i * 3 + 1] * scale];
}

test.before(async () => {
	await manager.initialize();
	const [real, imag] = await repellingFixedPoint();
	center = manager.translateCenter(real, imag, radius, -0.3, 0.2);
});
test.after(() => manager.cleanup());

test('a converged Julia cycle is repeated instead of iterated off the cycle', async () => {
	const newton = await manager.gmp.findPeriodicReferenceCenter(
		center.centerReal,
		center.centerImag,
		manager.scaleValue(radius, 1.5),
		{ ...options, shouldYield: false },
	);
	assert.equal(newton.converged, true);
	const target = budget + REFERENCE_ORBIT_RUNOFF;
	// Rounding error grows by the cycle multiplier each step, so the directly iterated
	// orbit leaves the repelling fixed point and escapes long before the budget.
	const direct = manager.gmp.computeReferenceData(newton.centerReal, newton.centerImag, target, options);
	assert.ok(direct.orbitLength < budget, `direct orbit length ${direct.orbitLength}`);

	const reference = await manager.findGoodReferenceCenter(
		center.centerReal,
		center.centerImag,
		radius,
		budget,
		target,
		options,
		manager.referenceRequestId,
	);
	assert.equal(reference.orbitLength, target);
	assert.equal(reference.centerRealExact, newton.centerReal);
	for (let i = 0; i + newton.period < target; i += 97)
		assert.deepEqual(
			Array.from(reference.orbit.subarray(i * 3, i * 3 + 3)),
			Array.from(reference.orbit.subarray((i + newton.period) * 3, (i + newton.period) * 3 + 3)),
		);
});

test('perturbation from the repeated cycle matches direct MPFR pixel orbits', async t => {
	const target = budget + REFERENCE_ORBIT_RUNOFF;
	const reference = await manager.findGoodReferenceCenter(
		center.centerReal,
		center.centerImag,
		radius,
		budget,
		target,
		options,
		manager.referenceRequestId,
	);
	const r = Number(radius);
	const counts = { interior: 0, escaped: 0 };
	let maxSmoothError = 0;
	for (let py = -2; py <= 2; py++)
		for (let px = -3; px <= 3; px++) {
			const pixel = manager.translateCenter(center.centerReal, center.centerImag, radius, px * 0.5, py * 0.5);
			const offset = manager.computeViewTransform(
				pixel.centerReal,
				pixel.centerImag,
				radius,
				reference.centerRealExact,
				reference.centerImagExact,
				radius,
			);
			// Double-precision mirror of the shader's Julia step, including its
			// invalid-pixel rules (cancellation and reference exhaustion).
			let dx = offset.offsetReal * r,
				dy = offset.offsetImag * r,
				perturbed = null;
			for (let i = 0; i < budget; i++) {
				const [x, y] = orbitPoint(reference.orbit, i);
				const nextDx = 2 * (x * dx - y * dy) + dx * dx - dy * dy;
				dy = 2 * (x * dy + y * dx) + 2 * dx * dy;
				dx = nextDx;
				const [nx, ny] = orbitPoint(reference.orbit, i + 1);
				const magnitudeSq = (nx + dx) ** 2 + (ny + dy) ** 2;
				assert.ok(magnitudeSq >= 1e-8 * (nx * nx + ny * ny), 'cancellation would mark the pixel invalid');
				assert.ok(i + 1 < reference.orbitLength - 1, 'the reference ran out');
				if (magnitudeSq > 4) {
					perturbed = { iteration: i + 1, magnitude: Math.sqrt(magnitudeSq) };
					break;
				}
			}
			const exact = manager.gmp.computeReferenceData(pixel.centerReal, pixel.centerImag, budget + 1, options);
			let expected = null;
			for (let i = 1; i < exact.orbitLength && !expected; i++) {
				const magnitude = Math.hypot(...orbitPoint(exact.orbit, i));
				if (magnitude > 2) expected = { iteration: i, magnitude };
			}
			assert.equal(perturbed?.iteration, expected?.iteration, `pixel ${px}, ${py}`);
			if (!expected) counts.interior++;
			else {
				counts.escaped++;
				maxSmoothError = Math.max(
					maxSmoothError,
					Math.abs(
						smoothEscape(perturbed.iteration, perturbed.magnitude) -
							smoothEscape(expected.iteration, expected.magnitude),
					),
				);
			}
		}
	t.diagnostic(JSON.stringify({ ...counts, maxSmoothError }));
	assert.ok(counts.interior > 0 && counts.escaped > 0, JSON.stringify(counts));
	// Same tolerance as the GPU check of deep pixels against direct repair.
	assert.ok(maxSmoothError < 0.01, `max smooth escape error ${maxSmoothError}`);
});

test('short Newton orbits fall back to sampling, which must cover the budget for Julia', async () => {
	const lengths = new Map([['newton', 700]]);
	const stub = new DeepZoomManager();
	stub.gmp = {
		findPeriodicReferenceCenter: async () => ({
			centerReal: 'newton',
			centerImag: '0',
			period: 3,
			converged: false,
		}),
		scaleValue: () => '1',
		translateCenter: (_real, _imag, _radius, dx, dy) => ({ centerReal: `${dx},${dy}`, centerImag: '0' }),
		computeReferenceData: (real, _imag, iterations) => {
			const orbitLength = Math.min(iterations, lengths.get(real) ?? 300);
			return { orbit: new Float32Array(orbitLength * 3), orbitLength };
		},
	};
	const search = (fractalType, required) =>
		stub.findGoodReferenceCenter('center', '0', '1', required, required + 4096, { fractalType, exponent: 2 }, 0);

	// A sample at 97% of the budget satisfies Mandelbrot, which rebases, but not Julia.
	lengths.set('0.15,0', 3980);
	lengths.set('-0.7,0', 4096 + REFERENCE_ORBIT_RUNOFF);
	assert.equal((await search(1, 4096)).centerRealExact, '0.15,0');
	assert.equal((await search(0, 4096)).centerRealExact, '-0.7,0');
	// When no sample beats the Newton orbit, the longer Newton orbit is kept.
	lengths.delete('0.15,0');
	lengths.delete('-0.7,0');
	const kept = await search(0, 4096);
	assert.equal(kept.centerRealExact, 'newton');
	assert.equal(kept.orbitLength, 700);
});
