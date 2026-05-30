// Pure view/zoom coordinate math. Zoom is stored as a base-2 exponent; the deep-zoom path
// needs the view radius as an exact decimal string, while the standard path needs an
// approximate float scale.

// The approximate (double-precision) center component is half the exact center value — the
// renderer's normalized coordinates run [-1, 1] over a [-2, 2] complex span. Returns null
// for non-finite input so callers can fall back.
export function getApproximatePositionFromCenterComponent(centerComponent) {
	const numericValue = Number(centerComponent);
	return Number.isFinite(numericValue) ? numericValue / 2 : null;
}

// Exact view radius (= 2^(1 - zoom)) as a decimal string. Uses a plain Number when the value
// fits in double range, and falls back to a mantissa/exponent string past ~1e±307 so deep
// zoom keeps a usable radius after double precision would underflow to 0.
export function getRadiusExactForZoom(zoom) {
	if (!Number.isFinite(zoom)) {
		return zoom > 0 ? '0' : '2';
	}

	const log10Radius = (1 - zoom) * Math.log10(2);
	if (log10Radius > -307 && log10Radius < 307) {
		const radius = Math.pow(2, 1 - zoom);
		if (Number.isFinite(radius) && radius > 0) {
			return radius.toString();
		}
	}

	const decimalExponent = Math.floor(log10Radius);
	const decimalMantissa = Math.pow(10, log10Radius - decimalExponent);
	return `${decimalMantissa.toPrecision(17)}e${decimalExponent}`;
}

// Approximate linear zoom scale (= 2^zoom) for the standard renderer, clamped to MAX_VALUE
// instead of overflowing to Infinity.
export function getApproximateZoomScale(zoom) {
	const zoomScale = Math.pow(2, zoom);
	return Number.isFinite(zoomScale) ? zoomScale : Number.MAX_VALUE;
}
