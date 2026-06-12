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

test('all four fractal types are supported at integer exponents 2-16', () => {
	const manager = new DeepZoomManager();
	for (const fractalType of [0, 1, 2, 3]) {
		for (const exponent of [2, 3, 7, 16]) {
			assert.ok(
				manager.supportsState({ ...baseState, fractalType, exponent }).supported,
				`type ${fractalType} at exponent ${exponent}`,
			);
		}
		for (const exponent of [1, 17, 2.5]) {
			assert.ok(
				!manager.supportsState({ ...baseState, fractalType, exponent }).supported,
				`type ${fractalType} at exponent ${exponent}`,
			);
		}
	}
	assert.ok(!manager.supportsState({ ...baseState, fractalType: 4 }).supported, 'unknown type');
});

test('only analytic quadratic variants use Newton/BLA acceleration', () => {
	const manager = new DeepZoomManager();
	assert.ok(manager.usesQuadraticAnalyticAcceleration({ fractalType: 0, exponent: 2 }));
	assert.ok(manager.usesQuadraticAnalyticAcceleration({ fractalType: 1, exponent: 2 }));
	assert.ok(!manager.usesQuadraticAnalyticAcceleration({ fractalType: 2, exponent: 2 }));
	assert.ok(!manager.usesQuadraticAnalyticAcceleration({ fractalType: 3, exponent: 2 }));
	assert.ok(!manager.usesQuadraticAnalyticAcceleration({ fractalType: 1, exponent: 3 }));
});

test('Mandala reference signatures depend on the constant; Burning Ship signatures do not', () => {
	const manager = new DeepZoomManager();
	const mandala = { ...baseState, fractalType: 3 };
	const movedConstant = { cReal: -0.5, cImaginary: 0.25 };

	assert.notEqual(
		manager.getReferenceSignature(mandala),
		manager.getReferenceSignature({ ...mandala, ...movedConstant }),
	);
	assert.notEqual(
		manager.getReferenceCompatibilitySignature(mandala),
		manager.getReferenceCompatibilitySignature({ ...mandala, ...movedConstant }),
	);

	const ship = { ...baseState, fractalType: 2 };
	assert.equal(manager.getReferenceSignature(ship), manager.getReferenceSignature({ ...ship, ...movedConstant }));
	assert.equal(
		manager.getReferenceCompatibilitySignature(ship),
		manager.getReferenceCompatibilitySignature({ ...ship, ...movedConstant }),
	);
});
