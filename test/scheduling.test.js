import test from 'node:test';
import assert from 'node:assert/strict';
import { getDeepIterationBudget, getReferenceIterationCount } from '../src/render/scheduling.js';
import { REFERENCE_ORBIT_RUNOFF } from '../src/shaderCommon.js';
import { ORBIT_CAPACITY } from '../src/gmpUtils.js';
import { DEEP_MAX_ITERATIONS } from '../src/config.js';

test('references cover the budget plus stripe runoff, including at the iteration cap', () => {
	for (const zoom of [16, 33.25, 60, 83.75, 153.5, 165.3, 165.4, 200, 1328]) {
		const budget = getDeepIterationBudget(zoom);
		assert.ok(getReferenceIterationCount(zoom, budget) >= budget + REFERENCE_ORBIT_RUNOFF, `zoom ${zoom}`);
	}
	assert.equal(getDeepIterationBudget(200), DEEP_MAX_ITERATIONS);
	assert.equal(getReferenceIterationCount(200, DEEP_MAX_ITERATIONS), 65570);
	assert.equal(getReferenceIterationCount(200, DEEP_MAX_ITERATIONS), ORBIT_CAPACITY);
});

test('reference lengths stay quantized so zooming does not recompute every frame', () => {
	const counts = new Set();
	for (let zoom = 60; zoom < 61; zoom += 0.05)
		counts.add(getReferenceIterationCount(zoom, getDeepIterationBudget(zoom)));
	assert.ok(counts.size <= 2);
	// Near the cap the budget changes every frame while the reference length does not.
	assert.equal(getReferenceIterationCount(165.2, getDeepIterationBudget(165.2)), ORBIT_CAPACITY);
	assert.equal(getReferenceIterationCount(165.3, getDeepIterationBudget(165.3)), ORBIT_CAPACITY);
});
