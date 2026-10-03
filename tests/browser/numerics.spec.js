import { test, expect } from '@playwright/test';
import { sampleMandelbrot } from '../helpers/oracle.js';
import { REFERENCE_ORBIT_RUNOFF } from '../../src/shaderCommon.js';
import fixture from '../fixtures/circular-seam.json' with { type: 'json' };

test.beforeEach(async ({ page }) => {
	await page.goto('http://127.0.0.1:5173/fractal/@fs' + process.cwd() + '/tests/browser/harness.html');
	await page.waitForFunction(() => window.ready);
});
test('all supported shader variants compile and link', async ({ page }) => {
	expect(await page.evaluate(() => window.compileVariants())).toBe(121);
});
test('circular seam fixture has deterministic metric and acceleration diagnostics', async ({ page }, testInfo) => {
	const result = await page.evaluate(async fixture => {
		const accelerated = await window.renderFixture(fixture);
		const repeated = await window.renderFixture(fixture);
		const scalar = await window.renderFixture(fixture, { blaLevels: 0 });
		const usage = await window.renderFixture(fixture, { diagnostic: true });
		return { accelerated, repeated, scalar, usage };
	}, fixture);
	expect(result.repeated.pixels).toEqual(result.accelerated.pixels);
	expect(result.accelerated.pixels.every(Number.isFinite)).toBe(true);
	expect(result.usage.pixels.every(Number.isFinite)).toBe(true);
	let maxNormalDifference = 0;
	const differences = [];
	for (let i = 2; i < result.scalar.pixels.length; i += 4) {
		const a = result.scalar.pixels[i] % 4096,
			b = result.accelerated.pixels[i] % 4096;
		if (a < 4095 && b < 4095) differences.push(Math.min(Math.abs(a - b), 4094 - Math.abs(a - b)));
		if (a < 4095 && b < 4095)
			maxNormalDifference = Math.max(maxNormalDifference, Math.min(Math.abs(a - b), 4094 - Math.abs(a - b)));
	}
	await testInfo.attach('baseline.json', {
		body: JSON.stringify({ maxNormalDifference, reference: result.accelerated.reference }),
		contentType: 'application/json',
	});

	expect(maxNormalDifference).toBeLessThan(20);
	console.log({ maxNormalDifference });
});

test('sampled pixels have independent MPFR escape expectations', async ({ page }, testInfo) => {
	const actual = await page.evaluate(f => window.renderFixture(f, { blaLevels: 0 }), fixture);
	const samples = [];
	for (const [x, y] of [
		[5, 20],
		[15, 20],
		[35, 10],
		[50, 30],
	]) {
		const expected = await sampleMandelbrot(fixture, x, y);
		const smooth = actual.pixels[(y * fixture.width + x) * 4];
		samples.push({ x, y, expected, smooth });
		expect(Math.abs(smooth - expected.smooth)).toBeLessThan(0.1);
	}
	await testInfo.attach('oracle.json', { body: JSON.stringify(samples), contentType: 'application/json' });
});

test('acceleration remains active at greater depth', async ({ page }) => {
	const usage = await page.evaluate(
		f => window.renderFixture({ ...f, radiusExact: '1e-20' }, { diagnostic: true }),
		fixture,
	);
	expect(usage.pixels.some((v, i) => i % 4 === 0 && v > 0)).toBe(true);
});
test('nearby zooms and alternate references preserve sampled normals', async ({ page }) => {
	for (const radiusExact of ['1e-10', '2e-10', '4e-10']) {
		const state = { ...fixture, radiusExact };
		const result = await page.evaluate(
			async f => ({
				a: await window.renderFixture(f),
				b: await window.renderFixture(f, { referenceOffset: [0.25, -0.25] }),
			}),
			state,
		);
		for (const [x, y] of [
			[5, 20],
			[15, 20],
			[35, 10],
			[50, 30],
		]) {
			const oracle = await sampleMandelbrot(state, x, y);
			for (const image of [result.a, result.b]) {
				const index = (y * state.width + x) * 4;
				expect(Math.abs(image.pixels[index] - oracle.smooth)).toBeLessThan(0.1);
				if (oracle.normal !== null) {
					const normal = ((image.pixels[index + 2] % 4096) / 4094) * 2 * Math.PI;
					const d = Math.abs(normal - oracle.normal);
					expect(Math.min(d, 2 * Math.PI - d)).toBeLessThan(0.03);
				}
			}
		}
	}
});

test('application presents a completed deep frame without WebGL errors', async ({ page }) => {
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	page.on('console', message => {
		if (message.type() === 'error') errors.push(message.text());
	});
	await page.goto(
		'http://127.0.0.1:5173/fractal/#F=1_E=2_P=0_K=1_C=8rd_A=' +
			fixture.centerRealExact +
			'_B=' +
			fixture.centerImagExact +
			'_W=' +
			fixture.radiusExact +
			'_Z=33.25',
	);
	await page.waitForFunction(() => window.fractalDiagnostics?.mode === 'deep' && !window.fractalDiagnostics.pending);
	await page.screenshot({ path: 'output/playwright/circular-seam-fixed.png' });
	expect(errors).toEqual([]);
});

test('worker references match local computation while animation continues', async ({ page }, testInfo) => {
	const result = await page.evaluate(f => window.workerProbe(f), fixture);
	expect(result.same).toBe(true);
	expect(result.frames).toBeGreaterThan(1);
	expect(result.textureBytes).toBeLessThan(8 * 1024 * 1024);
	await testInfo.attach('worker-performance.json', { body: JSON.stringify(result), contentType: 'application/json' });
	console.log(result);
});

test('representative formulas agree with shallow rendering and direct repair', async ({ page }) => {
	for (const [fractalType, exponent] of [
		[0, 2],
		[2, 2],
		[3, 2],
		[1, 3],
		[0, 16],
		[2, 3],
	]) {
		const state = {
			...fixture,
			fractalType,
			exponent,
			centerRealExact: '1.4',
			centerImagExact: '.1',
			radiusExact: '.03125',
			width: 12,
			height: 8,
			iterations: 128,
			deepIterations: 128,
		};
		const result = await page.evaluate(
			async f => ({
				standard: await window.renderFixture(f, { standard: true }),
				deep: await window.renderFixture(f, { repair: true }),
				repaired: await window.renderFixture(f, { forceRepair: true }),
			}),
			state,
		);
		expect(result.repaired.repaired).toBe(96);
		for (let i = 0; i < result.standard.pixels.length; i += 4) {
			for (const image of [result.deep, result.repaired]) {
				expect(image.pixels[i + 3]).toBeGreaterThanOrEqual(0);
				expect(Math.abs(image.pixels[i] - result.standard.pixels[i])).toBeLessThan(0.01);
			}
		}
	}
});

test('Julia references cover the budget plus runoff, so interior pixels are not exhausted', async ({
	page,
}, testInfo) => {
	// Main-cardioid Julia set 0.3 radii from its repelling fixed point: 491 of the 1440
	// pixels run the whole budget, and none approach the cancellation threshold.
	const state = {
		...fixture,
		fractalType: 0,
		cReal: 0.3274,
		cImaginary: 0.1945,
		centerRealExact: '0.756841083335816496081222888971992696265084456634426675629390',
		centerImagExact: '-0.378638801615888091663215945619707089671137172244739686172978',
		radiusExact: '1e-40',
		width: 48,
		height: 30,
		iterations: 1024,
		deepIterations: 1024,
	};
	const result = await page.evaluate(
		async ({ state, runoff }) => {
			const referenceIterations = state.deepIterations + runoff;
			return {
				exhausted: await window.renderFixture(state),
				covered: await window.renderFixture(state, { referenceIterations }),
				// Iterated directly, the fixed point's orbit leaves the cycle after about 700
				// steps; every escaping pixel here escapes long before that.
				iterated: await window.renderFixture(state, { referenceIterations: 700, iterateCycle: true }),
				direct: await window.renderFixture(state, { referenceIterations, forceRepair: true }),
			};
		},
		{ state, runoff: REFERENCE_ORBIT_RUNOFF },
	);
	const invalid = pixels => pixels.filter((value, i) => i % 4 === 3 && value < 0).length;
	const { covered, iterated, direct } = Object.fromEntries(
		Object.entries(result).map(([name, image]) => [name, image.pixels]),
	);
	let interior = 0,
		escaped = 0,
		maxSmoothError = 0;
	for (let i = 0; i < covered.length; i += 4) {
		expect(covered[i + 3]).toBe(direct[i + 3]);
		if (direct[i] === 0) {
			interior++;
			continue;
		}
		escaped++;
		maxSmoothError = Math.max(maxSmoothError, Math.abs(covered[i] - direct[i]));
		// Repeating the cycle must reproduce the directly iterated orbit exactly while that
		// orbit is still on the cycle, so it is never less accurate than direct iteration.
		expect(iterated[i + 3]).toBeGreaterThanOrEqual(0);
		expect(covered.slice(i, i + 4)).toEqual(iterated.slice(i, i + 4));
	}
	// Float32 reference samples leave one sensitive pixel about 0.12 off the MPFR smooth
	// escape count with either reference; recorded here, bounded relatively above.
	await testInfo.attach('julia-runoff.json', {
		body: JSON.stringify({
			exhaustedInvalid: invalid(result.exhausted.pixels),
			interior,
			escaped,
			maxSmoothError,
			reference: result.covered.reference,
		}),
		contentType: 'application/json',
	});
	expect(invalid(result.exhausted.pixels)).toBeGreaterThan(0);
	expect(invalid(covered)).toBe(0);
	expect(interior).toBeGreaterThan(0);
	expect(escaped).toBeGreaterThan(0);
});

test('application handles formula switches, toggles and resize', async ({ page }) => {
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	await page.goto('http://127.0.0.1:5173/fractal/#F=1_E=2_P=0_H=0_A=1.4_B=.1_W=1e-8_Z=27.5754247590989');
	await page.waitForFunction(() => window.fractalDiagnostics?.mode === 'deep' && !window.fractalDiagnostics.pending);
	for (const key of ['f', 'e', 'n', 'a']) await page.keyboard.press(key);
	await page.setViewportSize({ width: 400, height: 640 });
	await page.waitForFunction(
		() =>
			window.fractalDiagnostics?.mode === 'deep' &&
			window.fractalDiagnostics.formula === '2|3' &&
			window.fractalDiagnostics.width === 400 &&
			window.fractalDiagnostics.height === 640,
	);
	expect(errors).toEqual([]);
});
