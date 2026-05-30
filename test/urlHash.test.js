import assert from 'node:assert/strict';
import test from 'node:test';

import {
	getUrlCenterFractionDigits,
	roundPlainDecimalStringToFractionDigits,
	serializeStateValueForHash,
} from '../src/urlHash.js';

test('rounds and truncates fraction digits, half-up', () => {
	assert.equal(roundPlainDecimalStringToFractionDigits('1.23456', 2), '1.23');
	assert.equal(roundPlainDecimalStringToFractionDigits('1.235', 2), '1.24');
	assert.equal(roundPlainDecimalStringToFractionDigits('1.234', 2), '1.23');
});

test('carries through the fraction and into the integer part', () => {
	assert.equal(roundPlainDecimalStringToFractionDigits('1.299', 2), '1.3'); // trailing zero trimmed
	assert.equal(roundPlainDecimalStringToFractionDigits('0.999', 2), '1');
	assert.equal(roundPlainDecimalStringToFractionDigits('9.95', 1), '10');
	assert.equal(roundPlainDecimalStringToFractionDigits('99.96', 1), '100');
});

test('preserves sign and normalizes zeros', () => {
	assert.equal(roundPlainDecimalStringToFractionDigits('-1.235', 2), '-1.24');
	assert.equal(roundPlainDecimalStringToFractionDigits('-0.004', 2), '0'); // rounds to zero, sign dropped
	assert.equal(roundPlainDecimalStringToFractionDigits('000.500', 2), '0.5');
	assert.equal(roundPlainDecimalStringToFractionDigits('5', 2), '5');
});

test('rounds to zero fraction digits', () => {
	assert.equal(roundPlainDecimalStringToFractionDigits('2.5', 0), '3');
	assert.equal(roundPlainDecimalStringToFractionDigits('2.4', 0), '2');
});

test('passes through values it must not touch (scientific / empty / shorter)', () => {
	assert.equal(roundPlainDecimalStringToFractionDigits('1.8488980539881274e-102', 6), '1.8488980539881274e-102');
	assert.equal(roundPlainDecimalStringToFractionDigits('', 6), '');
	assert.equal(roundPlainDecimalStringToFractionDigits('1.2', 5), '1.2'); // fewer digits than requested
});

test('getUrlCenterFractionDigits scales with zoom and guards non-finite', () => {
	assert.equal(getUrlCenterFractionDigits(1), 6); // radius digits 0 + guard 6
	assert.equal(getUrlCenterFractionDigits(Infinity), 17);
	assert.ok(getUrlCenterFractionDigits(100) > getUrlCenterFractionDigits(10));
});

test('serializeStateValueForHash only rounds the exact deep-center strings', () => {
	const digits = getUrlCenterFractionDigits(1); // 6
	assert.equal(serializeStateValueForHash('deepCenterReal', '1.23456789', digits), '1.234568');
	assert.equal(serializeStateValueForHash('deepCenterImag', '1.23456789', digits), '1.234568');
	// Non-center keys pass through untouched.
	assert.equal(serializeStateValueForHash('zoom', 12.5, digits), 12.5);
	assert.equal(serializeStateValueForHash('paletteId', 'abc', digits), 'abc');
});
