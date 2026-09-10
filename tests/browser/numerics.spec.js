import { test, expect } from '@playwright/test';
import { sampleMandelbrot } from '../helpers/oracle.js';
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
	await page.waitForFunction(() => window.fractalDiagnostics?.mode === 'deep');
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
