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

test('visual prefix differences match direct shader addend sums', () => {
	const orbit = buildOrbit(128);
	const prefix = buildVisualPrefixTextureData(orbit);
	const start = 19;
	const chunk = 32;
	let detailTotal = 0;
	let stripeTotal = 0;
	let lastStripeValue = 0.5;

	for (let i = start + 1; i <= start + chunk; i++) {
		const x = orbit[i * 3] * Math.pow(2, orbit[i * 3 + 2]);
		const y = orbit[i * 3 + 1] * Math.pow(2, orbit[i * 3 + 2]);
		detailTotal += orbitDetailValue(x, y);
		lastStripeValue = stripeAverageAddend(x, y);
		stripeTotal += lastStripeValue;
	}

	const before = start * 4;
	const after = (start + chunk) * 4;
	assert.ok(Math.abs(prefix[after] - prefix[before] - detailTotal) < 1e-5);
	assert.ok(Math.abs(prefix[after + 1] - prefix[before + 1] - stripeTotal) < 1e-5);
	assert.ok(Math.abs(prefix[after + 2] - lastStripeValue) < 1e-6);
});
