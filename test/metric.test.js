import test from 'node:test';
import assert from 'node:assert/strict';
import { GMPUtils } from '../src/gmpUtils.js';
import { repairMetrics } from '../src/render/metric.js';
import { sampleMandelbrot } from '../tests/helpers/oracle.js';
import fixture from '../tests/fixtures/circular-seam.json' with { type: 'json' };
test('invalid pixels are repaired with a direct MPFR orbit', async () => {
	const gmp = new GMPUtils();
	await gmp.init();
	try {
		const state = { ...fixture, width: 1, height: 1 };
		const pixels = new Float32Array([-1, 0, 0, -1]);
		assert.equal(repairMetrics(gmp, pixels, state, 1, 1), 1);
		const expected = await sampleMandelbrot(state, 0, 0);
		assert.ok(Math.abs(pixels[0] - expected.smooth) < 0.01);
		assert.ok(pixels[3] >= 0);
		assert.equal(repairMetrics(gmp, pixels, state, 1, 1), 0);
	} finally {
		gmp.cleanup();
	}
});

test('adaptive repair increases precision when metrics disagree and retains the full-precision fallback', () => {
	const precisions = [];
	const gmp = {
		precision: 512,
		translateCenter: () => ({ centerReal: '0', centerImag: '0' }),
		computeReferenceData(_real, _imag, _iterations, { precisionBits }) {
			precisions.push(precisionBits);
			return { orbit: new Float32Array([0, 0, 0, precisionBits / 100, 0, 1]) };
		},
	};
	const pixels = new Float32Array([-1, 0, 0, -1]);
	repairMetrics(gmp, pixels, { ...fixture, radiusExact: '1e-5' }, 1, 1, undefined, { adaptive: true });
	assert.deepEqual(precisions, [192, 384, 512]);
	assert.equal(pixels[3], 1);
});

test('adaptive repair matches full precision at the reported deeper Julia view', async () => {
	const gmp = new GMPUtils();
	await gmp.init();
	try {
		const state = {
			...fixture,
			fractalType: 0,
			centerRealExact: '-0.5026773568807897644818506313983',
			centerImagExact: '-0.2137760019002827098156989404876',
			radiusExact: '1.2296113373026906e-25',
		};
		const full = new Float32Array(8 * 4);
		for (let i = 3; i < full.length; i += 4) full[i] = -1;
		const adaptive = full.slice();
		repairMetrics(gmp, full, state, 4, 2);
		repairMetrics(gmp, adaptive, state, 4, 2, undefined, { adaptive: true });
		assert.deepEqual(adaptive, full);
	} finally {
		gmp.cleanup();
	}
});
