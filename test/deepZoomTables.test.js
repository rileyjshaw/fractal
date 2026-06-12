import assert from 'node:assert/strict';
import test from 'node:test';

import {
	BLA_BASE_CHUNK_SIZE,
	BLA_INVALID_RSQ_LOG2,
	buildDirectBLAEntry,
	buildHierarchicalBLATable,
	buildVisualPrefixTextureData,
	composeBLAEntries,
	orbitDetailValue,
	readBLAEntry,
	stripeAverageAddend,
} from '../src/deepZoomTables.js';
import { STRIPE_EWMA_ALPHA } from '../src/shaderCommon.js';

function buildOrbit(length) {
	const orbit = new Float32Array(length * 3);
	let x = 0;
	let y = 0;
	const cx = -0.743643887037151;
	const cy = 0.13182590420533;
	for (let i = 0; i < length; i++) {
		orbit[i * 3] = x;
		orbit[i * 3 + 1] = y;
		orbit[i * 3 + 2] = 0;
		const nextX = x * x - y * y + cx;
		const nextY = 2 * x * y + cy;
		x = nextX;
		y = nextY;
	}
	return orbit;
}

function complexToNumber(value) {
	return {
		r: value.mantR * Math.pow(2, value.exp),
		i: value.mantI * Math.pow(2, value.exp),
	};
}

function assertComplexClose(actual, expected, tolerance = 1e-5) {
	const a = complexToNumber(actual);
	const e = complexToNumber(expected);
	assert.ok(Math.abs(a.r - e.r) <= tolerance * Math.max(1, Math.abs(e.r)), `real ${a.r} != ${e.r}`);
	assert.ok(Math.abs(a.i - e.i) <= tolerance * Math.max(1, Math.abs(e.i)), `imag ${a.i} != ${e.i}`);
}

function assertClose(actual, expected, tolerance = 1e-5) {
	assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}

test('hierarchical level 0 matches direct 32-step BLA composition', () => {
	const orbit = buildOrbit(160);
	const table = buildHierarchicalBLATable(orbit, { maxLevels: 1 });
	const direct = buildDirectBLAEntry(orbit, 17, BLA_BASE_CHUNK_SIZE);
	const fromTable = readBLAEntry(table, 0, 17);

	assertComplexClose(fromTable.a, direct.a);
	assertComplexClose(fromTable.b, direct.b);
	assertClose(fromTable.validityRsqLog2, direct.validityRsqLog2);
});

test('hierarchical level 1 A/B matches direct 64-step BLA composition', () => {
	const orbit = buildOrbit(160);
	const table = buildHierarchicalBLATable(orbit, { maxLevels: 2 });
	const direct = buildDirectBLAEntry(orbit, 11, BLA_BASE_CHUNK_SIZE * 2);
	const fromTable = readBLAEntry(table, 1, 11);

	assertComplexClose(fromTable.a, direct.a);
	assertComplexClose(fromTable.b, direct.b);
	assert.ok(Number.isFinite(fromTable.validityRsqLog2));
});

test('hierarchical tail entries are invalid when a full chunk does not fit', () => {
	const orbit = buildOrbit(80);
	const table = buildHierarchicalBLATable(orbit, { maxLevels: 2 });
	const baseTail = readBLAEntry(table, 0, 80 - BLA_BASE_CHUNK_SIZE + 1);
	const levelTail = readBLAEntry(table, 1, 80 - BLA_BASE_CHUNK_SIZE * 2 + 1);

	assert.ok(baseTail.validityRsqLog2 <= BLA_INVALID_RSQ_LOG2 * 0.5);
	assert.ok(levelTail.validityRsqLog2 <= BLA_INVALID_RSQ_LOG2 * 0.5);
});

test('composed validity is no looser than child validity constraints', () => {
	const orbit = buildOrbit(160);
	const left = buildDirectBLAEntry(orbit, 9, BLA_BASE_CHUNK_SIZE);
	const right = buildDirectBLAEntry(orbit, 9 + BLA_BASE_CHUNK_SIZE, BLA_BASE_CHUNK_SIZE);
	const composed = composeBLAEntries(left, right);

	assert.ok(composed.validityRsqLog2 <= left.validityRsqLog2);
	assert.ok(composed.validityRsqLog2 <= right.validityRsqLog2);
});

test('visual prefix stripe channel follows the shared EWMA recurrence', () => {
	const orbit = buildOrbit(128);
	const prefix = buildVisualPrefixTextureData(orbit);
	let detailTotal = 0;
	let stripeEwma = 0.5;
	let lastStripeValue = 0.5;

	assert.equal(prefix[1], 0.5);

	for (let i = 1; i < 128; i++) {
		const x = orbit[i * 3] * Math.pow(2, orbit[i * 3 + 2]);
		const y = orbit[i * 3 + 1] * Math.pow(2, orbit[i * 3 + 2]);
		detailTotal += orbitDetailValue(x, y);
		lastStripeValue = stripeAverageAddend(x, y);
		stripeEwma += (lastStripeValue - stripeEwma) * STRIPE_EWMA_ALPHA;
		if (i === 1 || i === 19 || i === 51 || i === 127) {
			assert.ok(Math.abs(prefix[i * 4] - detailTotal) < 1e-5, `detail at ${i}`);
			assert.ok(Math.abs(prefix[i * 4 + 1] - stripeEwma) < 1e-6, `ewma at ${i}`);
			assert.ok(Math.abs(prefix[i * 4 + 2] - lastStripeValue) < 1e-6, `addend at ${i}`);
		}
	}
});

test('a BLA chunk jump reconstructs the pixel EWMA exactly via the prefix channel', () => {
	const orbit = buildOrbit(128);
	const prefix = buildVisualPrefixTextureData(orbit);
	const start = 19;
	const chunk = 32;
	const decay = Math.pow(1 - STRIPE_EWMA_ALPHA, chunk);

	let pixelEwma = 0.5;
	for (let i = 1; i <= start; i++) {
		const x = orbit[i * 3] * Math.pow(2, orbit[i * 3 + 2]);
		const y = orbit[i * 3 + 1] * Math.pow(2, orbit[i * 3 + 2]);
		pixelEwma += (stripeAverageAddend(x, y) - pixelEwma) * STRIPE_EWMA_ALPHA;
	}
	const jumped = pixelEwma * decay + (prefix[(start + chunk) * 4 + 1] - prefix[start * 4 + 1] * decay);

	for (let i = start + 1; i <= start + chunk; i++) {
		const x = orbit[i * 3] * Math.pow(2, orbit[i * 3 + 2]);
		const y = orbit[i * 3 + 1] * Math.pow(2, orbit[i * 3 + 2]);
		pixelEwma += (stripeAverageAddend(x, y) - pixelEwma) * STRIPE_EWMA_ALPHA;
	}

	assert.ok(Math.abs(jumped - pixelEwma) < 1e-5, `${jumped} != ${pixelEwma}`);
});

test('visual prefix min channel carries the running orbit |z|² minimum', () => {
	const orbit = buildOrbit(128);
	const prefix = buildVisualPrefixTextureData(orbit);

	let minMagSq = Infinity;
	let cursor = 1;
	for (const index of [1, 17, 64, 127]) {
		for (; cursor <= index; cursor++) {
			const x = orbit[cursor * 3] * Math.pow(2, orbit[cursor * 3 + 2]);
			const y = orbit[cursor * 3 + 1] * Math.pow(2, orbit[cursor * 3 + 2]);
			minMagSq = Math.min(minMagSq, x * x + y * y);
		}
		assert.ok(Math.abs(prefix[index * 4 + 3] - minMagSq) < 1e-6 * Math.max(1, minMagSq), `index ${index}`);
	}

	assert.ok(prefix[3] > 1e29);
});
