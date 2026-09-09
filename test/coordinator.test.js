import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseFrame, canDeferFrame } from '../src/render/coordinator.js';
import { describeFrame } from '../src/render/frame.js';
const state = { fractalType: 1, exponent: 2, escapeRadius: 2 };
const request = { requested: true, supported: true, state, width: 800, height: 600 };
test('pending references hold only compatible completed frames', () => {
	const frame = describeFrame(state, 800, 600);
	assert.equal(chooseFrame({ ...request, referenceReady: true }), 'deep');
	assert.equal(chooseFrame({ ...request, frame }), 'held');
	assert.equal(chooseFrame({ ...request, frame, state: { ...state, fractalType: 0 } }), 'standard');
	assert.equal(chooseFrame({ ...request, frame, width: 900 }), 'standard');
	assert.equal(chooseFrame({ ...request, frame, requested: false }), 'standard');
});
test('motion can defer only a covered compatible preview', () => {
	const args = {
		...request,
		frame: describeFrame(state, 800, 600),
		moving: true,
		preview: { scale: 0.5, offsetReal: 0, offsetImag: 0 },
	};
	assert.equal(canDeferFrame(args), true);
	assert.equal(canDeferFrame({ ...args, moving: false }), false);
	assert.equal(canDeferFrame({ ...args, preview: { scale: 2, offsetReal: 0, offsetImag: 0 } }), false);
	assert.equal(canDeferFrame({ ...args, state: { ...state, exponent: 3 } }), false);
});
