import test from 'node:test';
import assert from 'node:assert/strict';
import {
	chooseFrame,
	chooseFallback,
	canDeferFrame,
	frameLoop,
	keepPendingReference,
	planDeepStep,
} from '../src/render/coordinator.js';
import { describeFrame } from '../src/render/frame.js';
import { STANDARD_FALLBACK_MAX_ZOOM_EXPONENT } from '../src/config.js';
const state = { fractalType: 1, exponent: 2, escapeRadius: 2 };
const request = { requested: true, supported: true, state, width: 800, height: 600 };
const preview = { scale: 0.5, offsetReal: 0, offsetImag: 0 };
test('pending references hold only compatible completed frames', () => {
	const frame = describeFrame(state, 800, 600);
	assert.equal(chooseFrame({ ...request, referenceReady: true }), 'deep');
	assert.equal(chooseFrame({ ...request, frame, preview }), 'held');
	assert.equal(chooseFrame({ ...request, frame, preview, state: { ...state, fractalType: 0 } }), 'fallback');
	assert.equal(chooseFrame({ ...request, frame, preview, width: 900 }), 'fallback');
	assert.equal(chooseFrame({ ...request, frame, preview, requested: false }), 'standard');
	assert.equal(chooseFrame({ ...request, frame, preview, supported: false }), 'standard');
});
test('a held frame without an anchor is never drawn, as after a reset', () => {
	const frame = describeFrame(state, 800, 600);
	assert.equal(chooseFrame({ ...request, frame, preview: null }), 'fallback');
});
test('deep views without a frame show a placeholder once float32 cannot resolve them', () => {
	assert.equal(chooseFallback(STANDARD_FALLBACK_MAX_ZOOM_EXPONENT - 1), 'standard');
	assert.equal(chooseFallback(STANDARD_FALLBACK_MAX_ZOOM_EXPONENT + 1), 'placeholder');
	assert.equal(chooseFallback(200), 'placeholder');
});
test('motion can defer only a covered compatible preview', () => {
	const args = { ...request, frame: describeFrame(state, 800, 600), moving: true, preview };
	assert.equal(canDeferFrame(args), true);
	assert.equal(canDeferFrame({ ...args, moving: false }), false);
	assert.equal(canDeferFrame({ ...args, preview: { scale: 2, offsetReal: 0, offsetImag: 0 } }), false);
	assert.equal(canDeferFrame({ ...args, preview: { scale: 0.2, offsetReal: 0, offsetImag: 0 } }), false);
	assert.equal(canDeferFrame({ ...args, state: { ...state, exponent: 3 } }), false);
});
test('a pending repair suppresses renders during motion but not once settled', () => {
	const frame = describeFrame(state, 800, 600);
	// Zoomed out: the held frame no longer covers the view, so without a pending
	// repair this view would render.
	const uncovered = { scale: 2, offsetReal: 0, offsetImag: 0 };
	const args = { ...request, target: 'b', rendered: 'a', frame, moving: true, preview: uncovered };
	assert.equal(planDeepStep(args), 'render');
	assert.equal(planDeepStep({ ...args, pending: 'a', pendingFrame: frame }), 'defer');
	assert.equal(planDeepStep({ ...args, pending: 'a', pendingFrame: frame, moving: false }), 'render');
	const otherFormula = describeFrame({ ...state, fractalType: 0 }, 800, 600);
	assert.equal(planDeepStep({ ...args, pending: 'a', pendingFrame: otherFormula }), 'render');
	assert.equal(planDeepStep({ ...args, preview }), 'defer');
});
test('published, pending and failed views are not rendered again', () => {
	const args = { ...request, target: 'b', frame: null, moving: false, preview: null };
	assert.equal(planDeepStep({ ...args, rendered: 'b' }), 'hold');
	assert.equal(planDeepStep({ ...args, pending: 'b' }), 'hold');
	assert.equal(planDeepStep({ ...args, failed: 'b' }), 'hold');
	assert.equal(planDeepStep({ ...args, failed: 'a' }), 'render');
});
test('in-flight references survive motion and are kept when settled only if they can reach the view', () => {
	const pending = { formula: '1|2', iterations: 20514 };
	const target = { formula: '1|2', iterations: 16384 };
	assert.equal(keepPendingReference({ moving: true, pending, target, reach: 40 }), true);
	assert.equal(keepPendingReference({ moving: false, pending, target, reach: 40 }), false);
	assert.equal(keepPendingReference({ moving: false, pending, target, reach: 2 }), true);
	assert.equal(keepPendingReference({ moving: true, pending: null, target, reach: 0 }), false);
	assert.equal(
		keepPendingReference({ moving: true, pending: { ...pending, formula: '0|2' }, target, reach: 0 }),
		false,
	);
	assert.equal(
		keepPendingReference({ moving: true, pending: { ...pending, iterations: 8192 }, target, reach: 0 }),
		false,
	);
});
test('the frame loop keeps scheduling after errors and reports a repeated error once', () => {
	const scheduled = [],
		reported = [];
	let failure = null;
	const loop = frameLoop(
		() => {
			if (failure) throw failure;
		},
		{ schedule: callback => scheduled.push(callback), report: error => reported.push(error.message) },
	);
	failure = Error('Unable to read deep metrics');
	loop(0);
	loop(1);
	failure = null;
	loop(2);
	failure = Error('Unable to read deep metrics');
	loop(3);
	assert.equal(scheduled.length, 4);
	assert.ok(scheduled.every(callback => callback === loop));
	assert.deepEqual(reported, ['Unable to read deep metrics', 'Unable to read deep metrics']);
});
