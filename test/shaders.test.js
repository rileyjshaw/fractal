import assert from 'node:assert/strict';
import test from 'node:test';

import { generateStandardShader } from '../src/standardShader.js';
import { generatePerturbationShader } from '../src/perturbationShader.js';
import { generateDeepDisplayShader } from '../src/deepDisplayShader.js';
import { N_COLORS } from '../src/shaderCommon.js';

// Iteration shaders bake fractalType/exponent into the generated source.
const VARIANTS = [];
for (const fractalType of [0, 1, 2, 3]) {
	for (const exponent of [2, 3, 16]) {
		VARIANTS.push({ fractalType, exponent });
	}
}

function variantLabel({ fractalType, exponent }) {
	return `type=${fractalType} exp=${exponent}`;
}

function allIterationShaders() {
	return VARIANTS.flatMap(variant => [
		{ name: `standard ${variantLabel(variant)}`, variant, src: generateStandardShader(variant) },
		{ name: `perturbation ${variantLabel(variant)}`, variant, src: generatePerturbationShader(variant) },
	]);
}

const iterationShaders = allIterationShaders();
const displayShader = generateDeepDisplayShader();

// Count GLSL function *definitions* (a return-type keyword immediately precedes the name);
// function calls like `return foo(` have no type prefix and are not counted.
function definitionCount(src, fn) {
	const re = new RegExp(`\\b(?:vec[234]|float|bool|void|int)\\s+${fn}\\s*\\(`, 'g');
	return (src.match(re) || []).length;
}

test('N_COLORS is injected once per shader and matches the shared JS constant', () => {
	for (const { name, src } of [...iterationShaders, { name: 'display', src: displayShader }]) {
		const defines = src.match(/#define N_COLORS \d+/g) || [];
		assert.equal(defines.length, 1, `${name} should define N_COLORS exactly once`);
		assert.equal(defines[0], `#define N_COLORS ${N_COLORS}`, `${name} N_COLORS should equal the JS constant`);
	}
});

test('baked variant defines match the requested variant', () => {
	for (const { name, variant, src } of iterationShaders) {
		assert.ok(src.includes(`#define FRACTAL_TYPE ${variant.fractalType}`), `${name} bakes FRACTAL_TYPE`);
		assert.ok(src.includes(`#define EXPONENT ${variant.exponent}`), `${name} bakes EXPONENT`);
		// The baked values replace the old uniforms entirely.
		for (const uniform of ['u_fractalType', 'u_exponent']) {
			assert.ok(!src.includes(uniform), `${name} should not reference ${uniform}`);
		}
	}
});

test('stripe averaging is display-only: iteration shaders are stripe-agnostic', () => {
	for (const { name, src } of iterationShaders) {
		// No stripe flag anywhere in the iteration passes — neither baked nor uniform.
		assert.ok(!src.includes('u_stripeAverage'), `${name} should not reference u_stripeAverage`);
		assert.ok(!/#define STRIPE_AVERAGE /.test(src), `${name} should not bake STRIPE_AVERAGE`);
		// Every escaped pixel runs the stripe runoff so metric.y is always valid.
		assert.ok(src.includes('STRIPE_RUNOFF_LIMIT'), `${name} should contain the stripe runoff`);
	}
	// The display pass owns the toggle.
	assert.ok(displayShader.includes('uniform int u_stripeAverage'), 'display should own u_stripeAverage');
});

test('the display pass reprojects the held metric frame for zoom preview', () => {
	assert.ok(displayShader.includes('uniform float u_previewScale'), 'display should take a preview scale');
	assert.ok(displayShader.includes('uniform vec2 u_previewOffset'), 'display should take a preview offset');
	assert.ok(
		displayShader.includes('viewDelta * u_previewScale + u_previewOffset'),
		'display should remap sampling coordinates through the preview transform',
	);
	assert.ok(
		displayShader.includes('mix(mix(c00, c10, cornerWeights.x), mix(c01, c11, cornerWeights.x), cornerWeights.y)'),
		'display should bilinearly blend final colors during reprojection',
	);
});

test('stripe coloring uses the EWMA recurrence everywhere', () => {
	for (const { name, src } of iterationShaders) {
		assert.ok(
			src.includes('mix(stripeEwma, stripeAverageAddend('),
			`${name} should accumulate the stripe EWMA per iteration`,
		);
		assert.ok(!src.includes('stripeTotal'), `${name} should not keep a stripe running sum`);
	}
	// BLA variants carry the EWMA across chunk skips with baked per-level decay factors.
	for (const fractalType of [0, 1]) {
		const src = generatePerturbationShader({ fractalType, exponent: 2 });
		assert.ok(src.includes('BLA_STRIPE_EWMA_CHUNK_DECAY'), `type ${fractalType} BLA should bake EWMA chunk decay`);
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
		'orbitDetailValue',
		'buildMetric',
	];
	for (const { name, src } of iterationShaders) {
		for (const fn of iterationShared) {
			assert.equal(definitionCount(src, fn), 1, `${name} should define ${fn} once`);
		}
		assert.equal(definitionCount(src, 'isFiniteFloat'), 1, `${name} should define isFiniteFloat once`);
	}
	assert.equal(definitionCount(displayShader, 'isFiniteFloat'), 1, 'display should define isFiniteFloat once');
});

test('the metric-pack format agrees across all shaders', () => {
	// The iteration passes pack the metric; the display pass unpacks it. These constants
	// must be identical everywhere or the unpacked detail/normal data is garbage.
	const packConstants = [
		'METRIC_PACK_COMPONENT_SCALE',
		'METRIC_PACK_DETAIL_SCALE',
		'METRIC_PACK_NORMAL_BINS',
		'METRIC_PACK_NORMAL_SENTINEL',
	];
	const allShaders = [...iterationShaders, { name: 'display', src: displayShader }];
	for (const constant of packConstants) {
		const values = allShaders.map(({ name, src }) => {
			const match = src.match(new RegExp(`${constant} = ([0-9.]+)`));
			assert.ok(match, `${name} should define ${constant}`);
			return match[1];
		});
		assert.ok(
			values.every(value => value === values[0]),
			`${constant} should match across shaders (got ${[...new Set(values)]})`,
		);
	}
});

test('the removed series-approximation path stays gone from the perturbation shader', () => {
	for (const variant of VARIANTS) {
		const src = generatePerturbationShader(variant);
		for (const uniform of [
			'u_seriesApproximation',
			'u_poly1',
			'u_poly2',
			'u_polynomialLimit',
			'u_stripeAveragePresum',
		]) {
			assert.ok(!src.includes(uniform), `perturbation ${variantLabel(variant)} should not reference ${uniform}`);
		}
	}
});

test('BLA exists exactly for analytic quadratic perturbation variants', () => {
	for (const variant of VARIANTS) {
		const src = generatePerturbationShader(variant);
		const expectBLA = (variant.fractalType === 0 || variant.fractalType === 1) && variant.exponent === 2;
		assert.equal(
			src.includes('u_blaTable'),
			expectBLA,
			`perturbation ${variantLabel(variant)} BLA table presence should be ${expectBLA}`,
		);
		assert.equal(
			src.includes('u_visualPrefixTexture'),
			expectBLA,
			`perturbation ${variantLabel(variant)} visual prefix presence should be ${expectBLA}`,
		);
		// Variants without BLA rely on cycle detection instead.
		assert.equal(
			src.includes('tortoise'),
			!expectBLA,
			`perturbation ${variantLabel(variant)} cycle detection presence should be ${!expectBLA}`,
		);
	}
});

test('high-exponent variants unroll the binomial with literal coefficients', () => {
	// C(16,8) = 12870 only appears if the power-16 expansion was emitted in full.
	for (const fractalType of [0, 1, 2, 3]) {
		const src = generatePerturbationShader({ fractalType, exponent: 16 });
		assert.ok(src.includes('12870.0 * '), `type ${fractalType} power-16 should contain C(16,8) as a literal`);
		assert.ok(!src.includes('for (int blaLevel'), `type ${fractalType} power-16 should not contain a BLA loop`);
	}
	// Folded high-exponent variants must take per-component diffabs before powering.
	const foldedSrc = generatePerturbationShader({ fractalType: 2, exponent: 3 });
	assert.ok(foldedSrc.includes('sumMantU'), 'folded power-3 should diffabs the x component');
	assert.ok(foldedSrc.includes('sumMantV'), 'folded power-3 should diffabs the y component');
});

test('the Burning Ship conjugation survives in every ship variant', () => {
	for (const exponent of [2, 3, 16]) {
		const standard = generateStandardShader({ fractalType: 2, exponent });
		assert.ok(standard.includes('vec2(1.0, -1.0) * coord'), `standard ship exp ${exponent} flips the coord plane`);
		const perturbation = generatePerturbationShader({ fractalType: 2, exponent });
		assert.ok(
			perturbation.includes('float baseDeltaY = -('),
			`perturbation ship exp ${exponent} conjugates the delta`,
		);
	}
});

test('standard variants emit exactly one iterate function for the baked type', () => {
	for (const variant of VARIANTS) {
		const src = generateStandardShader(variant);
		assert.equal(definitionCount(src, 'iterate'), 1, `standard ${variantLabel(variant)} defines iterate once`);
		const expectEarlyOut = variant.fractalType === 1 && variant.exponent === 2;
		assert.equal(
			src.includes('inMandelbrotInterior'),
			expectEarlyOut,
			`standard ${variantLabel(variant)} cardioid early-out presence should be ${expectEarlyOut}`,
		);
	}
});
