import test from 'node:test';
import assert from 'node:assert/strict';
import { paletteNoise } from '../src/render/paletteNoise.js';
test('palette extension is deterministic and bounded', () => {
	const first = Array.from({ length: 32 }, (_, i) => paletteNoise('8rd', i, 0));
	assert.deepEqual(
		first,
		Array.from({ length: 32 }, (_, i) => paletteNoise('8rd', i, 0)),
	);
	assert.ok(first.every(n => n >= -0.05 && n <= 0.05));
	assert.notDeepEqual(
		first,
		Array.from({ length: 32 }, (_, i) => paletteNoise('8rd', i, 1)),
	);
});
