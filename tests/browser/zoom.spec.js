import { test, expect } from '@playwright/test';
import { GMPUtils } from '../../src/gmpUtils.js';
import fixture from '../fixtures/circular-seam.json' with { type: 'json' };

test('Julia repair presents a complete frame without a long preview', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 960, height: 600 });
	await page.goto(
		'http://127.0.0.1:5173/fractal/#F=0_E=2_P=0_H=0_A=-0.50267735688078976448664_B=-0.213776001900282709822774_W=1.7347234759783363e-18_Z=59.99999999999873',
	);
	await page.waitForFunction(() => window.fractalDiagnostics?.mode === 'deep' && !window.fractalDiagnostics.pending);
	// Software WebGL speed varies severalfold with host load, so the bound is relative.
	// The longest frame while waiting is the render of the new view plus its readback;
	// repair may not take much longer than that. Before sparse parallel repair, this
	// view spent more than 15 s repairing after a render of a few seconds.
	const timing = await page
		.locator('canvas')
		.first()
		.evaluate(async canvas => {
			const initial = window.fractalDiagnostics.frame;
			const start = performance.now();
			for (let j = 0; j < 10; j++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
			let last = start,
				longestFrameMs = 0;
			while (performance.now() - start < 60000) {
				await new Promise(requestAnimationFrame);
				const now = performance.now();
				longestFrameMs = Math.max(longestFrameMs, now - last);
				last = now;
				const d = window.fractalDiagnostics;
				if (!d.moving && !d.pending && d.frame === d.targetFrame && d.frame !== initial)
					return { settledMs: now - start, longestFrameMs, repairedPixels: d.repairedPixels };
			}
			return { settledMs: null, longestFrameMs };
		});
	await testInfo.attach('progress.json', {
		body: JSON.stringify({ timing, diagnostics: await page.evaluate(() => window.fractalDiagnostics) }),
		contentType: 'application/json',
	});
	expect(timing.settledMs).not.toBeNull();
	expect(timing.repairedPixels).toBeGreaterThan(0);
	expect(timing.settledMs).toBeLessThan(3 * timing.longestFrameMs + 3000);
});

test('a continuous wheel burst completes its jobs and presents frames before input stops', async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 320, height: 200 });
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto(
		'http://127.0.0.1:5173/fractal/#F=0_E=2_P=0_H=0_A=-0.50267735688078976448664_B=-0.213776001900282709822774_W=1.7347234759783363e-18_Z=59.99999999999873',
	);
	await page.waitForFunction(
		() => {
			const d = window.fractalDiagnostics;
			return d?.mode === 'deep' && !d.pending && d.frame === d.targetFrame;
		},
		undefined,
		{ timeout: 60000 },
	);
	// Wheel events every 50 ms keep the view moving (it settles after 200 ms) for six
	// zoom units, far enough to outgrow the initial reference and preview.
	const burst = await page
		.locator('canvas')
		.first()
		.evaluate(async canvas => {
			const before = structuredClone(window.fractalDiagnostics.jobs);
			const initial = window.fractalDiagnostics.frame;
			const frames = new Set();
			let stoppedMoving = false;
			for (let i = 0; i < 120; i++) {
				canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
				await new Promise(resolve => setTimeout(resolve, 50));
				const d = window.fractalDiagnostics;
				if (!d.moving) stoppedMoving = true;
				if (d.frame !== initial) frames.add(d.frame);
			}
			return {
				before,
				after: structuredClone(window.fractalDiagnostics.jobs),
				frames: frames.size,
				stoppedMoving,
			};
		});
	await testInfo.attach('wheel-burst.json', { body: JSON.stringify(burst), contentType: 'application/json' });
	expect(burst.stoppedMoving).toBe(false);
	for (const kind of ['reference', 'repair']) {
		expect(burst.after[kind].cancelled - burst.before[kind].cancelled).toBe(0);
		expect(burst.after[kind].failed - burst.before[kind].failed).toBe(0);
	}
	expect(burst.after.reference.completed + burst.after.repair.completed).toBeGreaterThan(
		burst.before.reference.completed + burst.before.repair.completed,
	);
	expect(burst.frames).toBeGreaterThan(0);
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const d = window.fractalDiagnostics;
					return !d.moving && !d.pending && d.mode === 'deep' && d.frame === d.targetFrame;
				}),
			{ timeout: 60000 },
		)
		.toBe(true);
	expect(errors).toEqual([]);
});

test('reset drops the held deep frame', async ({ page }) => {
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	const view = (real, imag) => `F=1_E=2_P=0_H=0_A=${real}_B=${imag}_W=${fixture.radiusExact}_Z=33.25`;
	await page.goto(`http://127.0.0.1:5173/fractal/#${view(fixture.centerRealExact, fixture.centerImagExact)}`);
	await page.waitForFunction(() => {
		const d = window.fractalDiagnostics;
		return d?.mode === 'deep' && !d.pending && d.frame === d.targetFrame;
	});
	await page.keyboard.press('x');
	// Return to the same depth elsewhere before a new reference exists. The frame from
	// before the reset has no anchor, so it must not be drawn at the new location.
	const modes = await page.evaluate(
		async hash => {
			location.hash = hash;
			const seen = [];
			for (let i = 0; i < 5; i++) {
				await new Promise(requestAnimationFrame);
				seen.push(window.fractalDiagnostics.mode);
			}
			return seen;
		},
		view('-0.8685', '-0.2570'),
	);
	expect(modes).not.toContain('deep');
	expect(modes).toContain('placeholder');
	await page.waitForFunction(
		() => {
			const d = window.fractalDiagnostics;
			return d?.mode === 'deep' && !d.pending && d.frame === d.targetFrame;
		},
		undefined,
		{ timeout: 60000 },
	);
	expect(errors).toEqual([]);
});

test('fast zoom and pan settles to the same view as a reload', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 320, height: 200 });
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	// Offset the starting center so the intervening clicks land back on the
	// reported Julia feature at zoom 60, rather than an uninformative flat exterior.
	const gmp = new GMPUtils();
	await gmp.init();
	let center = { centerReal: '-0.50267735688078976448664', centerImag: '-0.213776001900282709822774' };
	try {
		for (let i = 0; i < 20; i += 3) {
			center = gmp.translateCenter(
				center.centerReal,
				center.centerImag,
				String(2 ** (1 - (50 + (i + 1) / 2))),
				i % 2 ? -0.2 : 0.2,
				0,
			);
		}
	} finally {
		gmp.cleanup();
	}
	await page.goto(
		`http://127.0.0.1:5173/fractal/#F=0_E=2_P=0_H=0_C=y54_A=${center.centerReal}_B=${center.centerImag}_W=1.7763568394002505e-15_Z=50`,
	);
	await page.waitForFunction(() => window.fractalDiagnostics?.mode === 'deep');
	await page
		.locator('canvas')
		.first()
		.evaluate(async canvas => {
			for (let i = 0; i < 20; i++) {
				for (let j = 0; j < 10; j++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
				if (i % 3 === 0)
					canvas.dispatchEvent(new MouseEvent('click', { clientX: 160 + (i % 2 ? 20 : -20), clientY: 100 }));
				await new Promise(requestAnimationFrame);
			}
		});
	try {
		await expect
			.poll(
				() =>
					page.evaluate(() => {
						const d = window.fractalDiagnostics;
						return (
							!d.moving &&
							!d.pending &&
							!d.pendingReference &&
							d.mode === 'deep' &&
							d.frame === d.targetFrame
						);
					}),
				{ timeout: 20000 },
			)
			.toBe(true);
	} finally {
		await testInfo.attach('settled.json', {
			body: JSON.stringify(await page.evaluate(() => window.fractalDiagnostics)),
			contentType: 'application/json',
		});
	}
	await page.addStyleTag({ content: '#info { visibility: hidden; }' });
	const before = await page.screenshot({ path: testInfo.outputPath('after-interaction.png') });
	await testInfo.attach('after-interaction.png', { body: before, contentType: 'image/png' });
	await page.reload();
	await page.waitForFunction(() => window.fractalDiagnostics?.mode === 'deep' && !window.fractalDiagnostics.pending);
	await page.addStyleTag({ content: '#info { visibility: hidden; }' });
	const after = await page.screenshot({ path: testInfo.outputPath('after-reload.png') });
	await testInfo.attach('after-reload.png', { body: after, contentType: 'image/png' });
	const difference = await page.evaluate(
		async ({ before, after }) => {
			async function decode(bytes) {
				const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
				const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
				const context = canvas.getContext('2d');
				context.drawImage(bitmap, 0, 0);
				const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
				bitmap.close();
				return data;
			}
			const a = await decode(before),
				b = await decode(after);
			let total = 0;
			for (let i = 0; i < a.length; i++) if (i % 4 !== 3) total += Math.abs(a[i] - b[i]);
			return total / (a.length * 0.75);
		},
		{ before: Array.from(before), after: Array.from(after) },
	);
	await testInfo.attach('image-difference.json', {
		body: JSON.stringify({ meanChannelDifference: difference }),
		contentType: 'application/json',
	});
	expect(difference).toBeLessThan(3);
	expect(errors).toEqual([]);
});

test('deeper Julia gap fixture repairs against direct MPFR pixels', async ({ page }, testInfo) => {
	await page.goto('http://127.0.0.1:5173/fractal/@fs' + process.cwd() + '/tests/browser/harness.html');
	await page.waitForFunction(() => window.ready);
	const state = {
		...fixture,
		fractalType: 0,
		centerRealExact: '-0.5026773568807897644818506313983',
		centerImagExact: '-0.2137760019002827098156989404876',
		radiusExact: '1.2296113373026906e-25',
		zoom: 83.75,
		width: 48,
		height: 30,
	};
	const result = await page.evaluate(
		async state => ({
			actual: await window.repairFixture(state),
			expected: await window.renderFixture(state, { forceRepair: true }),
		}),
		state,
	);
	let maximumRepairError = 0;
	for (let i = 0; i < result.actual.pixels.length; i += 4) {
		expect(result.actual.pixels[i + 3]).toBe(result.expected.pixels[i + 3]);
		if (result.actual.originalPixels[i + 3] < 0)
			maximumRepairError = Math.max(
				maximumRepairError,
				Math.abs(result.actual.pixels[i] - result.expected.pixels[i]),
			);
	}
	expect(result.actual.repaired).toBeGreaterThan(0);
	expect(maximumRepairError).toBeLessThan(0.001);
	await testInfo.attach('gap-repair.json', {
		body: JSON.stringify({ maximumRepairError, repaired: result.actual.repaired }),
		contentType: 'application/json',
	});
});

test('application presents the deeper gap view only after repair completes', async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 640, height: 400 });
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	await page.addInitScript(() => {
		window.partialFramePublished = false;
		const observe = () => {
			const d = window.fractalDiagnostics;
			if (d?.mode === 'deep' && d.pending && d.frame === null) window.partialFramePublished = true;
			requestAnimationFrame(observe);
		};
		requestAnimationFrame(observe);
	});
	await page.goto(
		'http://127.0.0.1:5173/fractal/#C=y54_F=0_E=2_P=0_H=0_A=-0.5026773568807897644818506313983_B=-0.2137760019002827098156989404876_W=1.2296113373026906e-25_Z=83.74999999999739',
	);
	await page.waitForFunction(
		() => {
			const d = window.fractalDiagnostics;
			return d?.mode === 'deep' && !d.pending && d.frame === d.targetFrame;
		},
		undefined,
		{ timeout: 30000 },
	);
	expect(await page.evaluate(() => window.fractalDiagnostics.invalidPixels)).toBe(0);
	await page.addStyleTag({ content: '#info {visibility:hidden}' });
	await page.screenshot({ path: testInfo.outputPath('gap-view-complete.png') });
	expect(await page.evaluate(() => window.partialFramePublished)).toBe(false);
	expect(errors).toEqual([]);
});
