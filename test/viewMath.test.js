import assert from 'node:assert/strict';
import test from 'node:test';

import {
	getApproximatePositionFromCenterComponent,
	getApproximateZoomScale,
	getRadiusExactForZoom,
} from '../src/viewMath.js';

test('getRadiusExactForZoom returns a plain decimal in double range', () => {
	assert.equal(getRadiusExactForZoom(1), '1'); // 2^0
	assert.equal(getRadiusExactForZoom(11), '0.0009765625'); // 2^-10
	assert.equal(Number(getRadiusExactForZoom(50)), Math.pow(2, 1 - 50));
});

test('getRadiusExactForZoom falls back to mantissa/exponent past double range', () => {
	const radius = getRadiusExactForZoom(2000);
	assert.match(radius, /e-/, 'should be in scientific form');
	const [mantissa, exponent] = radius.split('e');
	assert.ok(Number(mantissa) >= 1 && Number(mantissa) < 10, `mantissa ${mantissa} should be in [1, 10)`);
	assert.ok(Number(exponent) < -307, `exponent ${exponent} should be past double underflow`);
});

test('getRadiusExactForZoom guards non-finite zoom', () => {
	assert.equal(getRadiusExactForZoom(Infinity), '0');
	assert.equal(getRadiusExactForZoom(-Infinity), '2');
	assert.equal(getRadiusExactForZoom(NaN), '2');
});

test('getApproximateZoomScale clamps overflow to MAX_VALUE', () => {
	assert.equal(getApproximateZoomScale(0), 1);
	assert.equal(getApproximateZoomScale(10), 1024);
	assert.equal(getApproximateZoomScale(5000), Number.MAX_VALUE);
});

test('getApproximatePositionFromCenterComponent halves finite input, null otherwise', () => {
	assert.equal(getApproximatePositionFromCenterComponent('1.5'), 0.75);
	assert.equal(getApproximatePositionFromCenterComponent('-4'), -2);
	assert.equal(getApproximatePositionFromCenterComponent('xyz'), null);
});
