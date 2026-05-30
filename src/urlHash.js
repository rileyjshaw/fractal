// Decimal-string handling for URL-hash persistence.
//
// Deep-zoom center coordinates are carried as exact decimal strings (well beyond double
// precision), so the hash has to round them to a sensible number of fraction digits
// without going through Number() — which would collapse the precision the deep path
// depends on. These helpers round and normalize the decimal strings directly.

// Extra fraction digits kept past the radius precision, so the rounded center always
// resolves the current view's pixel grid with a little margin to spare.
const URL_CENTER_GUARD_DECIMAL_DIGITS = 6;

// Add 1 to a non-negative integer represented as a digit string (no Number() round-trip).
function incrementDigitString(value) {
	const digits = value.split('');
	let carry = 1;
	for (let i = digits.length - 1; i >= 0 && carry; i--) {
		const nextDigit = digits[i].charCodeAt(0) - 48 + carry;
		digits[i] = String(nextDigit % 10);
		carry = nextDigit >= 10 ? 1 : 0;
	}
	if (carry) digits.unshift('1');
	return digits.join('');
}

// Strip leading zeros from the integer part and trailing zeros from the fraction, collapsing
// an all-zero value to '0'.
function normalizeDecimalString(sign, integerPart, fractionalPart) {
	const normalizedInteger = integerPart.replace(/^0+(?=\d)/, '') || '0';
	const normalizedFraction = fractionalPart.replace(/0+$/, '');
	if (normalizedInteger === '0' && normalizedFraction === '') return '0';
	return `${sign}${normalizedInteger}${normalizedFraction ? `.${normalizedFraction}` : ''}`;
}

// Round a plain (non-scientific) decimal string to `fractionDigits` places, half-up, carrying
// into the integer part as needed. Scientific-notation or empty input is returned unchanged.
export function roundPlainDecimalStringToFractionDigits(value, fractionDigits) {
	const input = String(value).trim();
	if (input === '' || input.includes('e') || input.includes('E')) return value;

	const sign = input[0] === '-' || input[0] === '+' ? input[0] : '';
	const unsignedInput = sign ? input.slice(1) : input;
	const decimalIndex = unsignedInput.indexOf('.');
	if (decimalIndex === -1) return normalizeDecimalString(sign === '-' ? '-' : '', unsignedInput, '');

	let integerPart = unsignedInput.slice(0, decimalIndex) || '0';
	const fractionalPart = unsignedInput.slice(decimalIndex + 1);
	if (fractionalPart.length <= fractionDigits) {
		return normalizeDecimalString(sign === '-' ? '-' : '', integerPart, fractionalPart);
	}

	let roundedFraction = fractionalPart.slice(0, fractionDigits);
	if (fractionalPart.charCodeAt(fractionDigits) >= 53) {
		if (fractionDigits === 0) {
			integerPart = incrementDigitString(integerPart);
		} else {
			const incrementedFraction = incrementDigitString(roundedFraction);
			if (incrementedFraction.length > fractionDigits) {
				integerPart = incrementDigitString(integerPart);
				roundedFraction = '0'.repeat(fractionDigits);
			} else {
				roundedFraction = incrementedFraction.padStart(fractionDigits, '0');
			}
		}
	}

	return normalizeDecimalString(sign === '-' ? '-' : '', integerPart, roundedFraction);
}

// Fraction digits to keep for the center coordinates at a given zoom: enough to resolve the
// view radius plus a fixed guard margin.
export function getUrlCenterFractionDigits(zoom) {
	if (!Number.isFinite(zoom)) return 17;
	const radiusDecimalDigits = Math.max(0, Math.ceil((zoom - 1) * Math.log10(2)));
	return radiusDecimalDigits + URL_CENTER_GUARD_DECIMAL_DIGITS;
}

// Serialize one state value for the hash. Only the exact deep-center strings need rounding;
// everything else passes through untouched.
export function serializeStateValueForHash(key, value, urlCenterFractionDigits) {
	switch (key) {
		case 'deepCenterReal':
		case 'deepCenterImag':
			return roundPlainDecimalStringToFractionDigits(value, urlCenterFractionDigits);
		default:
			return value;
	}
}
