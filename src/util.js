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

// Safer than Number() or Number.parseFloat().
export function parseNumber(input) {
	if (input.trim() === '') return null;
	let parsed = Number(input);
	if (!Number.isFinite(parsed)) return null;
	return parsed;
}

// Update the URL hash without adding to the History stack.
export function updateHash(hash) {
	if (window.location.hash.slice(1) === hash) return;
	window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${hash}`);
}

/**
 * Returns a debounced version of the passed function.
 *
 *   • = event
 *   x = trigger
 *
 *   With default arguments:
 *   • • • •      • • • •
 *           x            x
 *
 *   With triggerFirstCall = true, triggerLastCall = true:
 *   • • • •      • • • •
 *   x       x    x       x
 *
 *   With triggerFirstCall = true, triggerLastCall = false:
 *   • • • •      • • • •
 *   x            x
 */
export function debounce(fn, ms, { triggerFirstCall = false, triggerLastCall = true } = {}) {
	let timeout = null;
	function _debounce() {
		if (triggerFirstCall && timeout == null) fn(...arguments);
		else clearTimeout(timeout);
		timeout = setTimeout(() => {
			if (triggerLastCall) fn(...arguments);
			timeout = null;
		}, ms);
	}
	// hehe…
	_debounce.clearTimeout = function _debounceClearTimeout() {
		clearTimeout(timeout);
		timeout = null;
	};
	return _debounce;
}

export function identity(x) {
	return x;
}
