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
