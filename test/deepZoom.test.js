import assert from 'node:assert/strict';
import test from 'node:test';

import { DeepZoomManager } from '../src/deepZoom.js';

const baseState = {
	centerRealExact: '-1.7',
	centerImagExact: '0',
	radiusExact: '1e-12',
	deepIterations: 16384,
	fractalType: 1,
	exponent: 2,
	cReal: -0.71,
	cImaginary: -0.43,
};

test('reference signature includes radius so recenter requests are not skipped', () => {
	const manager = new DeepZoomManager();
	const first = manager.getReferenceSignature(baseState);
	const second = manager.getReferenceSignature({ ...baseState, radiusExact: '1e-24' });

	assert.notEqual(first, second);
});

test('radius changes do not change formula compatibility', () => {
	const manager = new DeepZoomManager();
	const first = manager.getReferenceCompatibilitySignature(baseState);
	const second = manager.getReferenceCompatibilitySignature({ ...baseState, radiusExact: '1e-24' });

	assert.equal(first, second);
});
