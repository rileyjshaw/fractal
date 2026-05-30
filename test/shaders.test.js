import assert from 'node:assert/strict';
import test from 'node:test';

import { generateStandardShader } from '../src/standardShader.js';
import { generatePerturbationShader } from '../src/perturbationShader.js';
import { generateDeepDisplayShader } from '../src/deepDisplayShader.js';
import { N_COLORS } from '../src/shaderCommon.js';

const shaders = {
	standard: generateStandardShader(),
	perturbation: generatePerturbationShader(),
	display: generateDeepDisplayShader(),
};

// Count GLSL function *definitions* (a return-type keyword immediately precedes the name);
// function calls like `return foo(` have no type prefix and are not counted.
function definitionCount(src, fn) {
	const re = new RegExp(`\\b(?:vec[234]|float|bool|void|int)\\s+${fn}\\s*\\(`, 'g');
	return (src.match(re) || []).length;
}

test('N_COLORS is injected once per shader and matches the shared JS constant', () => {
	for (const [name, src] of Object.entries(shaders)) {
		const defines = src.match(/#define N_COLORS \d+/g) || [];
		assert.equal(defines.length, 1, `${name} should define N_COLORS exactly once`);
		assert.equal(defines[0], `#define N_COLORS ${N_COLORS}`, `${name} N_COLORS should equal the JS constant`);
	}
});

test('shared coloring/metric functions are defined exactly once (no drift back to local copies)', () => {
	// Shared by both iteration passes via shaderCommon.js. A count of 2 would mean a copy
	// was reintroduced into one shader instead of using the shared chunk.
	const iterationShared = [
		'cmul',
		'smoothEscape',
		'stripeAverageAddend',
		'stripePaletteOffset',
		'getSlopeNormalAngle',
		'packVisualMetric',
		'interiorMetric',
		'distanceEstimateMetrics',
		'buildDistanceMetric',
	];
	for (const fn of iterationShared) {
		assert.equal(definitionCount(shaders.standard, fn), 1, `standard should define ${fn} once`);
		assert.equal(definitionCount(shaders.perturbation, fn), 1, `perturbation should define ${fn} once`);
	}
	// isFiniteFloat is shared by all three passes.
	for (const [name, src] of Object.entries(shaders)) {
		assert.equal(definitionCount(src, 'isFiniteFloat'), 1, `${name} should define isFiniteFloat once`);
	}
});

test('the metric-pack format agrees across all three shaders', () => {
	// The two iteration passes pack the metric; the display pass unpacks it. These constants
	// must be identical everywhere or the unpacked detail/normal data is garbage.
	const packConstants = [
		'METRIC_PACK_COMPONENT_SCALE',
		'METRIC_PACK_DETAIL_SCALE',
		'METRIC_PACK_NORMAL_BINS',
		'METRIC_PACK_NORMAL_SENTINEL',
	];
	for (const constant of packConstants) {
		const values = Object.entries(shaders).map(([name, src]) => {
			const match = src.match(new RegExp(`${constant} = ([0-9.]+)`));
			assert.ok(match, `${name} should define ${constant}`);
			return match[1];
		});
		assert.ok(values.every(value => value === values[0]), `${constant} should match across shaders (got ${values})`);
	}
});

test('the removed series-approximation path stays gone from the perturbation shader', () => {
	for (const uniform of ['u_seriesApproximation', 'u_poly1', 'u_poly2', 'u_polynomialLimit', 'u_stripeAveragePresum']) {
		assert.ok(!shaders.perturbation.includes(uniform), `perturbation should not reference ${uniform}`);
	}
});
