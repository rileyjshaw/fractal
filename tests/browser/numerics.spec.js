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
	expect(result.usage.pixels.some((v, i) => i % 4 === 0 && v > 0)).toBe(true);
	let maxNormalDifference = 0;
	for (let i = 2; i < result.scalar.pixels.length; i += 4) {
		const a = result.scalar.pixels[i] % 4096,
			b = result.accelerated.pixels[i] % 4096;
		if (a < 4095 && b < 4095)
			maxNormalDifference = Math.max(maxNormalDifference, Math.min(Math.abs(a - b), 4094 - Math.abs(a - b)));
	}
	await testInfo.attach('baseline.json', {
		body: JSON.stringify({ maxNormalDifference, reference: result.accelerated.reference }),
		contentType: 'application/json',
	});
	// Baseline defect: remove this characterization when the numerical fix lands.
	expect(maxNormalDifference).toBeGreaterThan(100);
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
