import { STRIPE_EWMA_ALPHA } from './shaderCommon.js';

export const ORBIT_TEXTURE_SIZE = 1024;
export const ORBIT_TEXTURE_CHANNELS = 4;
export const ORBIT_TEXTURE_PIXELS = ORBIT_TEXTURE_SIZE * ORBIT_TEXTURE_SIZE;
export const ORBIT_TEXTURE_LENGTH = ORBIT_TEXTURE_PIXELS * ORBIT_TEXTURE_CHANNELS;

export const BLA_BASE_CHUNK_SIZE = 32;
export const BLA_MAX_LEVELS = 7;
export const BLA_LEVEL_STRIDE = 65536;
export const BLA_VALIDITY_EPSILON = 1e-3;
export const BLA_INVALID_RSQ_LOG2 = -1.0e30;
export const BLA_FLOATS_PER_ENTRY = 8;
export const BLA_TEXELS_PER_ENTRY = 2;
export const BLA_TEXTURE_WIDTH = ORBIT_TEXTURE_SIZE;
export const BLA_TEXTURE_HEIGHT = (BLA_LEVEL_STRIDE * BLA_MAX_LEVELS * BLA_TEXELS_PER_ENTRY) / BLA_TEXTURE_WIDTH;
export const BLA_TEXTURE_LENGTH = BLA_TEXTURE_WIDTH * BLA_TEXTURE_HEIGHT * 4;

function normalizeWide(mantR, mantI, exp) {
	const magSq = mantR * mantR + mantI * mantI;
	if (magSq === 0) return { mantR: 0, mantI: 0, exp: 0 };
	const halfLog = 0.5 * Math.log2(magSq);
	if (halfLog > -10 && halfLog < 10) return { mantR, mantI, exp };
	const shift = Math.round(halfLog);
	const factor = Math.pow(2, -shift);
	return { mantR: mantR * factor, mantI: mantI * factor, exp: exp + shift };
}

function multiplyComplexWide(a, b) {
	return normalizeWide(a.mantR * b.mantR - a.mantI * b.mantI, a.mantR * b.mantI + a.mantI * b.mantR, a.exp + b.exp);
}

function addComplexWide(a, b) {
	if (a.mantR === 0 && a.mantI === 0) return { ...b };
	if (b.mantR === 0 && b.mantI === 0) return { ...a };
	const commonExp = Math.max(a.exp, b.exp);
	const aScale = Math.pow(2, a.exp - commonExp);
	const bScale = Math.pow(2, b.exp - commonExp);
	return normalizeWide(a.mantR * aScale + b.mantR * bScale, a.mantI * aScale + b.mantI * bScale, commonExp);
}

function complexLogMagSq(value) {
	const magSq = value.mantR * value.mantR + value.mantI * value.mantI;
	return magSq > 0 ? Math.log2(magSq) + 2 * value.exp : -Infinity;
}

function complexLogMagnitude(value) {
	const logMagSq = complexLogMagSq(value);
	return Number.isFinite(logMagSq) ? logMagSq * 0.5 : -Infinity;
}

function complexAbsSumSqLog2(a, b) {
	const aLog = complexLogMagnitude(a);
	const bLog = complexLogMagnitude(b);
	if (aLog === -Infinity && bLog === -Infinity) return -Infinity;
	const maxLog = Math.max(aLog, bLog);
	const aTerm = aLog === -Infinity ? 0 : Math.pow(2, aLog - maxLog);
	const bTerm = bLog === -Infinity ? 0 : Math.pow(2, bLog - maxLog);
	return 2 * (maxLog + Math.log2(aTerm + bTerm));
}

function isEntryValid(entry) {
	return entry.validityRsqLog2 > BLA_INVALID_RSQ_LOG2 * 0.5;
}

function invalidEntry() {
	return {
		a: { mantR: 0, mantI: 0, exp: 0 },
		b: { mantR: 0, mantI: 0, exp: 0 },
		validityRsqLog2: BLA_INVALID_RSQ_LOG2,
	};
}

export function composeBLAEntries(left, right) {
	if (!isEntryValid(left) || !isEntryValid(right)) return invalidEntry();

	const a = multiplyComplexWide(right.a, left.a);
	const b = addComplexWide(multiplyComplexWide(right.a, left.b), right.b);
	const leftGrowthSqLog2 = complexAbsSumSqLog2(left.a, left.b);
	const rightAdjustedValidity =
		right.validityRsqLog2 - Math.max(0, Number.isFinite(leftGrowthSqLog2) ? leftGrowthSqLog2 : 0);

	return {
		a,
		b,
		validityRsqLog2: Math.min(left.validityRsqLog2, rightAdjustedValidity),
	};
}

export function buildDirectBLAEntry(orbit, start, chunkSize = BLA_BASE_CHUNK_SIZE) {
	const orbitLength = Math.floor(orbit.length / 3);
	if (start + chunkSize > orbitLength) return invalidEntry();

	const log2Epsilon = Math.log2(BLA_VALIDITY_EPSILON);
	let a = { mantR: 1, mantI: 0, exp: 0 };
	let b = { mantR: 0, mantI: 0, exp: 0 };
	let minRSqLog2 = Infinity;

	for (let n = 0; n < chunkSize; n++) {
		const src = (start + n) * 3;
		const zMantR = orbit[src];
		const zMantI = orbit[src + 1];
		const zExp = orbit[src + 2];
		const zMagSq = zMantR * zMantR + zMantI * zMantI;

		if (zMagSq === 0) {
			minRSqLog2 = -Infinity;
		} else {
			const zLogMagSq = Math.log2(zMagSq) + 2 * zExp;
			const aLogMagSq = complexLogMagSq(a);
			const bLogMagSq = complexLogMagSq(b);
			const abSumSqLog2 =
				aLogMagSq === -Infinity && bLogMagSq === -Infinity ? -Infinity : Math.max(aLogMagSq, bLogMagSq) + 2;
			const rSqLog2 = abSumSqLog2 === -Infinity ? Infinity : zLogMagSq + 2 * log2Epsilon - abSumSqLog2;
			if (rSqLog2 < minRSqLog2) minRSqLog2 = rSqLog2;
		}

		const twoZ = { mantR: 2 * zMantR, mantI: 2 * zMantI, exp: zExp };
		a = multiplyComplexWide(twoZ, a);
		b = addComplexWide(multiplyComplexWide(twoZ, b), { mantR: 1, mantI: 0, exp: 0 });
	}

	return {
		a,
		b,
		validityRsqLog2: minRSqLog2 === Infinity || minRSqLog2 === -Infinity ? BLA_INVALID_RSQ_LOG2 : minRSqLog2,
	};
}

export function getBLAEntryOffset(level, index) {
	return (level * BLA_LEVEL_STRIDE + index) * BLA_FLOATS_PER_ENTRY;
}

export function readBLAEntry(data, level, index) {
	const offset = getBLAEntryOffset(level, index);
	return {
		a: { mantR: data[offset], mantI: data[offset + 1], exp: data[offset + 2] },
		validityRsqLog2: data[offset + 3],
		b: { mantR: data[offset + 4], mantI: data[offset + 5], exp: data[offset + 6] },
	};
}

export function writeBLAEntry(data, level, index, entry) {
	const offset = getBLAEntryOffset(level, index);
	data[offset] = entry.a.mantR;
	data[offset + 1] = entry.a.mantI;
	data[offset + 2] = entry.a.exp;
	data[offset + 3] = entry.validityRsqLog2;
	data[offset + 4] = entry.b.mantR;
	data[offset + 5] = entry.b.mantI;
	data[offset + 6] = entry.b.exp;
	data[offset + 7] = 0;
}

export function buildHierarchicalBLATable(orbit, { maxLevels = BLA_MAX_LEVELS } = {}) {
	const orbitLength = Math.floor(orbit.length / 3);
	const levels = Math.max(1, Math.min(BLA_MAX_LEVELS, maxLevels));
	const data = new Float32Array(BLA_TEXTURE_LENGTH);

	for (let entry = 0; entry < BLA_LEVEL_STRIDE * BLA_MAX_LEVELS; entry++) {
		data[entry * BLA_FLOATS_PER_ENTRY + 3] = BLA_INVALID_RSQ_LOG2;
	}

	for (let level = 0; level < levels; level++) {
		const chunkSize = BLA_BASE_CHUNK_SIZE << level;
		const previousChunkSize = chunkSize >> 1;
		const maxIndex = Math.min(BLA_LEVEL_STRIDE, orbitLength);

		for (let index = 0; index < maxIndex; index++) {
			if (index + chunkSize > orbitLength) break;
			const entry =
				level === 0
					? buildDirectBLAEntry(orbit, index, chunkSize)
					: composeBLAEntries(
							readBLAEntry(data, level - 1, index),
							readBLAEntry(data, level - 1, index + previousChunkSize),
						);
			writeBLAEntry(data, level, index, entry);
		}
	}

	return data;
}

function safeExp2(exponent) {
	return Math.pow(2, Math.max(-126, Math.min(126, exponent)));
}

export function orbitDetailValue(x, y) {
	return 1 / (1 + x * x + y * y);
}

export function stripeAverageAddend(x, y) {
	return 0.5 + 0.5 * Math.sin(8 * Math.atan2(y, x));
}

export function buildVisualPrefixTextureData(orbit) {
	const orbitLength = Math.floor(orbit.length / 3);
	const capacity = Math.min(orbitLength, ORBIT_TEXTURE_PIXELS);
	const data = new Float32Array(ORBIT_TEXTURE_LENGTH);
	let detailTotal = 0;
	let stripeEwma = 0.5;
	let lastStripeValue = 0.5;
	let minMagSq = 1.0e30;
	if (capacity > 0) {
		data[1] = stripeEwma;
		data[2] = lastStripeValue;
		data[3] = minMagSq;
	}

	for (let i = 1; i < capacity; i++) {
		const src = i * 3;
		const scale = safeExp2(orbit[src + 2]);
		const x = orbit[src] * scale;
		const y = orbit[src + 1] * scale;
		detailTotal += orbitDetailValue(x, y);
		lastStripeValue = stripeAverageAddend(x, y);
		stripeEwma += (lastStripeValue - stripeEwma) * STRIPE_EWMA_ALPHA;
		minMagSq = Math.min(minMagSq, x * x + y * y);

		const dst = i * ORBIT_TEXTURE_CHANNELS;
		data[dst] = detailTotal;
		data[dst + 1] = stripeEwma;
		data[dst + 2] = lastStripeValue;
		data[dst + 3] = minMagSq;
	}

	return data;
}
