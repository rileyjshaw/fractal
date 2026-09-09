// Decimal-string magnitude without converting tiny radii through a Number.
export function decimalOrder(value) {
	const match = String(value)
		.trim()
		.match(/^[+-]?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
	if (!match || !(match[1] || match[2])) return NaN;
	const digits = match[1] + (match[2] || '');
	const first = digits.search(/[1-9]/);
	return first < 0 ? -Infinity : match[1].length - first - 1 + Number(match[3] || 0);
}
export function precisionForView(centerReal, centerImag, radius, width = 4096, height = 4096) {
	const depth = Math.max(0, decimalOrder(centerReal), decimalOrder(centerImag)) - decimalOrder(radius);
	if (!Number.isFinite(depth)) throw Error('Invalid view radius');
	return Math.max(128, Math.ceil((depth + 1) * Math.log2(10) + Math.log2(Math.max(1, width, height))) + 64);
}
export function logDecimal(value) {
	const order = decimalOrder(value);
	const digits = String(value)
		.replace(/e.*$/i, '')
		.replace(/[^0-9]/g, '')
		.replace(/^0+/, '');
	if (!digits) return -Infinity;
	return Math.log(Number(digits[0] + '.' + digits.slice(1, 17))) + order * Math.LN10;
}
