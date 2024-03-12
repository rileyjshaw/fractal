export function hexToNormalizedRGB(hex) {
	if (hex.startsWith('#')) {
		hex = hex.substring(1);
	}

	let r = parseInt(hex.substring(0, 2), 16) / 255;
	let g = parseInt(hex.substring(2, 4), 16) / 255;
	let b = parseInt(hex.substring(4, 6), 16) / 255;

	return [r, g, b];
}

// Shuffle an array in place.
export function shuffleArray(array) {
	if (array.length <= 1) return;
	for (let i = array.length - 1; i > 0; --i) {
		const j = Math.floor(Math.random() * (i + 1));
		[array[i], array[j]] = [array[j], array[i]];
	}
}

export function repeatArrayToLength(array, length) {
	return Array.from({ length }, (_, i) => array[i % array.length]);
}

// Convert a binary fraction to a decimal number.
export function binaryFractionToDecimal(binaryFraction) {
	let decimal = 0;
	// Split the binary string at the decimal point
	let parts = binaryFraction.split('.');
	if (parts.length === 2) {
		let fractionPart = parts[1];
		for (let i = 0; i < fractionPart.length; i++) {
			// For each digit after the decimal, convert and sum up
			decimal += parseInt(fractionPart[i]) * Math.pow(2, -(i + 1));
		}
	}
	return decimal;
}

// Generate an array of length `length`, where each element is within `bounds`.
// The first two elements are the `bounds`, and each subsequent element is the
// furthest possible number from all previous elements. For instance:
// generateFurthestSubsequentDistanceArray(5, [0, 1]) => [0, 1, 0.5, 0.25, 0.75]
export function generateFurthestSubsequentDistanceArray(length, bounds = [0, 1]) {
	const [min, max] = bounds;
	const array = [...bounds];
	const step = (max - min) / (length - 1);

	const prevIndices = [[0, length - 1]];

	for (let i = 2; i < length; i++) {
		const [prevMinIndex, prevMaxIndex] = prevIndices.shift();
		const middleIndex = Math.ceil((prevMinIndex + prevMaxIndex) / 2);
		array[i] = min + step * middleIndex;
		prevIndices.push([prevMinIndex, middleIndex]);
		prevIndices.push([middleIndex, prevMaxIndex]);
	}

	return array;
}
