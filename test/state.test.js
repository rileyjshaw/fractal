import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStatePatch, reconcileCamera } from '../src/state/viewState.js';
import { stateFromHash } from '../src/state/urlState.js';
import { describeFrame, frameCompatible, previewCovered } from '../src/render/frame.js';
import { GMPUtils } from '../src/gmpUtils.js';
const state = {
	fractalType: 1,
	exponent: 2,
	deepCenterReal: '-.8',
	deepCenterImag: '.2',
	deepRadius: '1e-400',
	zoom: 1328,
	xPosition: -0.4,
	yPosition: 0.1,
	escapeRadius: 2,
};
test('state validation rejects invalid shader variants and radii', () => {
	assert.deepEqual(validateStatePatch({ exponent: 2.5, fractalType: NaN, deepRadius: '0' }, state), {});
	assert.deepEqual(validateStatePatch({ exponent: 200, deepCenterReal: 'oops' }, state), { exponent: 16 });
});
test('exact centers win over legacy coordinates on hash restore', () => {
	const next = stateFromHash(
		'A=-0.812345678901234567890123_X=9_W=1e-400',
		state,
		{ deepCenterReal: 'A', xPosition: 'X', deepRadius: 'W' },
		{ deepCenterReal: x => x, xPosition: Number, deepRadius: x => x },
		[],
	).state;
	assert.equal(next.deepCenterReal, '-0.812345678901234567890123');
	assert.equal(next.xPosition, Number(next.deepCenterReal) / 2);
	assert.equal(next.deepRadius, '1e-400');
	assert.ok(next.zoom > 1328);
	assert.equal(reconcileCamera(state, { zoom: 20 }).deepRadius, String(2 ** -19));
});
test('frame reuse rejects formula, escape-radius and resolution changes', () => {
	const frame = describeFrame(state, 800, 600);
	assert.equal(frameCompatible(frame, state, 800, 600), true);
	for (const patch of [{ fractalType: 0 }, { exponent: 3 }, { escapeRadius: 1.5 }])
		assert.equal(frameCompatible(frame, { ...state, ...patch }, 800, 600), false);
	assert.equal(frameCompatible(frame, state, 801, 600), false);
	assert.equal(previewCovered({ scale: 1.1, offsetReal: 0, offsetImag: 0 }, 800, 600), false);
	assert.equal(previewCovered({ scale: 0.5, offsetReal: 0.1, offsetImag: 0.1 }, 800, 600), true);
});
test('adaptive precision preserves deep pan and reverse pan through e-400', async () => {
	const gmp = new GMPUtils();
	await gmp.init();
	try {
		for (const radius of ['1e-350', '1e-370', '1e-400']) {
			const moved = gmp.translateCenter('-.8', '.2', radius, 1, 0);
			const offset = gmp.computeViewTransform(moved.centerReal, moved.centerImag, radius, '-.8', '.2', radius);
			assert.ok(Math.abs(offset.offsetReal - 1) < 1e-10);
			const back = gmp.translateCenter(moved.centerReal, moved.centerImag, radius, -1, 0);
			const restored = gmp.computeViewTransform(back.centerReal, back.centerImag, radius, '-.8', '.2', radius);
			assert.ok(Math.abs(restored.offsetReal) < 1e-10);
		}
	} finally {
		gmp.cleanup();
	}
});
