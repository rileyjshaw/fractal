import ShaderPad from 'shaderpad';
import { createFullscreenCanvas, save } from 'shaderpad/util';
import { tinykeys } from 'tinykeys';
import { Tween, Easing } from '@tweenjs/tween.js';
import { registerSW } from 'virtual:pwa-register';

import palettes, { paletteIds } from './palettes.js';
import { debounce, hexToNormalizedRGB, identity, parseNumber, updateHash } from './util.js';
import handleTouch from './touch.js';
import { DeepZoomManager } from './deepZoom.js';
import { generateDeepDisplayShader } from './deepDisplayShader.js';
import { generatePerturbationShader } from './perturbationShader.js';

// Auto-update the service worker.
registerSW({ immediate: true });

import fragmentSource from './fractal.frag';

import './style.css';

const N_COLORS = 32;
const MIN_ZOOM = 1;
const STANDARD_RENDER_SAFE_MAX_ZOOM = 1e12;
const MAX_ZOOM_DECIMAL_EXPONENT = 400;
const DEEP_ZOOM_THRESHOLD = 16;
const MIN_EXPONENT = 2;
const MAX_EXPONENT = 16;
const MAX_CONSTANT_COMPONENT = 2.5;
const MIN_RESOLUTION_MULTIPLIER = 0.0625;
const MAX_RESOLUTION_MULTIPLIER = 2;
const MIN_ESCAPE_RADIUS = 0.8;
const MAX_ESCAPE_RADIUS = 2;
const MIN_SPACING = 0.1;
const MAX_SPACING = 2.0;
const MIN_COLOR_SCALE = 0.02;
const MAX_COLOR_SCALE = 1.0;
const MIN_SPEED = 0.1;
const MAX_SPEED = 4;
const BASE_ITERATIONS = 256;
const DEEP_MIN_ITERATIONS = 2048;
const DEEP_MAX_ITERATIONS = 65536;
const DEEP_ITERATION_ZOOM_FACTOR = 192;
const DEEP_ITERATION_QUANTUM = 256;
const DEEP_COMPATIBLE_REFERENCE_MAX_OFFSET = 2.5;
const DEEP_REFERENCE_RECENTER_OFFSET = 0.75;
// Start computing the deep reference orbit this many zoom units before crossing the
// deep-zoom threshold so the orbit is ready by the time the user actually needs it.
const DEEP_ZOOM_PREPARATION_MARGIN_EXPONENT = 3;
// When the orbit is computed (whether preemptively or on demand), target an
// iteration count covering a few more zoom units of headroom, so subsequent
// zooming-in doesn't immediately trigger another recompute and stall.
const DEEP_REFERENCE_ITERATION_HEADROOM_EXPONENT = 4;
// During interactive deep-zoom motion we render the iteration pass at reduced
// resolution to keep frame rate up. The drop is scaled by iteration budget so
// shallow deep zooms (where the GPU keeps up at full res) don't take a hit
// and only the deeper zooms — where the iteration shader is the bottleneck —
// trade pixels for frame rate. After this debounce we resize the canvas back
// to the user's preferred density and a fresh iteration pass refreshes the
// metric at full resolution.
//
// The previous strategy reprojected the last fully-iterated frame in the
// display shader during motion. It looked sharp at shallow deep zooms but
// stretched arbitrarily at Z>=130 once the iteration budget hit the cap and
// motion just kept magnifying the same stale frame. Resolution scaling stays
// consistent across all zoom levels.
const DEEP_INTERACTION_MOTION_SETTLE_MS = 200;
// Iteration budget below which motion stays at full resolution. Picked so
// canvas resizing during motion only kicks in once the iteration cost is
// meaningful (a few zoom units past the deep-zoom threshold).
const DEEP_INTERACTION_MOTION_FULL_RES_ITERATIONS = 4096;
// Hard floor for the motion resolution multiplier. Cost scales linearly with
// pixel count, so 1/3 linear is ~9x cheaper than full res.
const DEEP_INTERACTION_MOTION_MIN_FACTOR = 1 / 3;
const URL_CENTER_GUARD_DECIMAL_DIGITS = 6;

const ORBIT_TEXTURE_OPTIONS = {
	internalFormat: 'RGBA32F',
	format: 'RGBA',
	type: 'FLOAT',
	minFilter: 'NEAREST',
	magFilter: 'NEAREST',
	wrapS: 'CLAMP_TO_EDGE',
	wrapT: 'CLAMP_TO_EDGE',
	preserveY: false,
};

const METRIC_TEXTURE_OPTIONS = {
	internalFormat: 'RGBA32F',
	format: 'RGBA',
	type: 'FLOAT',
	minFilter: 'NEAREST',
	magFilter: 'NEAREST',
	wrapS: 'CLAMP_TO_EDGE',
	wrapT: 'CLAMP_TO_EDGE',
	preserveY: false,
};

const FRACTAL_TYPES = ['Julia', 'Mandelbrot', 'Burning Ship', 'Mandala'];

const MIN_ZOOM_EXPONENT = Math.log(MIN_ZOOM) / Math.log(2);
const MAX_ZOOM_EXPONENT = MAX_ZOOM_DECIMAL_EXPONENT / Math.log10(2);
const STANDARD_RENDER_SAFE_ZOOM_EXPONENT = Math.log(STANDARD_RENDER_SAFE_MAX_ZOOM) / Math.log(2);

const deepZoomManager = new DeepZoomManager({ threshold: DEEP_ZOOM_THRESHOLD });

let resolutionMultiplier = 1;
let standardRenderer = null;
let deepIterationRenderer = null;
let deepDisplayRenderer = null;
let lastUploadedDeepOrbitSignature = null;
let lastDeepIterationRenderSignature = null;
let lastUnsupportedDeepZoomReason = null;
let lastDeepZoomActive = false;
let activeRenderer = null;
let isDeepInteractionInMotion = false;
let colorsVersion = 0;
let standardRendererColorsVersion = -1;
let deepDisplayRendererColorsVersion = -1;
let cachedColorUniformValue = null;
let cachedColorUniformVersion = -1;

tinykeys(window, {
	KeyC: () => updateColors(1),
	'Shift+KeyC': () => updateColors(-1),
	KeyD: () => {
		setResolutionMultiplier(resolutionMultiplier * 2);
		showInfo(`Density: ${resolutionMultiplier * 100}%`);
	},
	'Shift+KeyD': () => {
		setResolutionMultiplier(resolutionMultiplier / 2);
		showInfo(`Density: ${resolutionMultiplier * 100}%`);
	},
	KeyE: () => {
		setState({ exponent: Math.min(MAX_EXPONENT, state.exponent + 1) });
		showInfo(`Exponent: ${state.exponent}`);
	},
	'Shift+KeyE': () => {
		setState({ exponent: Math.max(MIN_EXPONENT, state.exponent - 1) });
		showInfo(`Exponent: ${state.exponent}`);
	},
	KeyF: () => {
		setState({ fractalType: (state.fractalType + 1) % FRACTAL_TYPES.length });
		showInfo(`Fractal type: ${FRACTAL_TYPES[state.fractalType]}`);
	},
	'Shift+KeyF': () => {
		setState({ fractalType: (FRACTAL_TYPES.length + (state.fractalType - 1)) % FRACTAL_TYPES.length });
		showInfo(`Fractal type: ${FRACTAL_TYPES[state.fractalType]}`);
	},
	KeyG: () => {
		const colorScale = Math.min(MAX_COLOR_SCALE, state.colorScale * 1.15);
		setState({ colorScale });
		showInfo(`Color density: ${colorScale.toFixed(3)}`);
	},
	'Shift+KeyG': () => {
		const colorScale = Math.max(MIN_COLOR_SCALE, state.colorScale / 1.15);
		setState({ colorScale });
		showInfo(`Color density: ${colorScale.toFixed(3)}`);
	},
	KeyI: () => {
		setState({ cImaginary: Math.min(MAX_CONSTANT_COMPONENT, state.cImaginary + 0.01) });
		showInfo(`C (imaginary): ${state.cImaginary.toFixed(2)}`);
	},
	'Shift+KeyI': () => {
		setState({ cImaginary: Math.max(-MAX_CONSTANT_COMPONENT, state.cImaginary - 0.01) });
		showInfo(`C (imaginary): ${state.cImaginary.toFixed(2)}`);
	},
	KeyL: () => {
		showLabels = !showLabels;
		if (showLabels) {
			showInfo('Labels on');
		}
	},
	KeyN: () => {
		setState({ slopeShading: 1 - state.slopeShading });
		showInfo(state.slopeShading ? 'Slope shading on' : 'Slope shading off');
	},
	KeyO: () => {
		zoomTween.stop();
		positionTween.stop();
		setPreciseCenterState('0', '0', { syncSmoothed: true, persist: false });
		setZoomState(MIN_ZOOM_EXPONENT, { syncSmoothed: isPreciseNavigationActive(), persist: true });
		if (isPreciseNavigationActive()) return;
		zoomTween.to([MIN_ZOOM_EXPONENT], 500).startFromCurrentValues();
		positionTween.to([0, 0], 2000).startFromCurrentValues();
	},
	KeyQ: () => {
		const newValue = state.escapeRadius + 0.01;
		setState({ escapeRadius: Math.min(MAX_ESCAPE_RADIUS, newValue === 1 ? 1.01 : newValue) });
		showInfo(`Escape radius: ${state.escapeRadius.toFixed(2)}`);
	},
	'Shift+KeyQ': () => {
		const newValue = state.escapeRadius - 0.01;
		setState({ escapeRadius: Math.max(MIN_ESCAPE_RADIUS, newValue === 0 ? 0.01 : newValue) });
		showInfo(`Escape radius: ${state.escapeRadius.toFixed(2)}`);
	},
	KeyR: () => {
		setState({ cReal: Math.min(MAX_CONSTANT_COMPONENT, state.cReal + 0.01) });
		showInfo(`C (real): ${state.cReal.toFixed(2)}`);
	},
	'Shift+KeyR': () => {
		setState({ cReal: Math.max(-MAX_CONSTANT_COMPONENT, state.cReal - 0.01) });
		showInfo(`C (real): ${state.cReal.toFixed(2)}`);
	},
	KeyS: () => {
		setState({ speed: Math.min(MAX_SPEED, state.speed + 0.1) });
		showInfo(`Speed: ${state.speed.toFixed(1)}`);
	},
	'Shift+KeyS': () => {
		setState({ speed: Math.max(MIN_SPEED, state.speed - 0.1) });
		showInfo(`Speed: ${state.speed.toFixed(1)}`);
	},
	KeyT: () => {
		setState({ transitionSmoothing: 1 - state.transitionSmoothing });
		showInfo(`Transition smoothing: ${state.transitionSmoothing ? 'on' : 'off'}`);
	},
	KeyU: () => {
		setState({ spacing: Math.min(MAX_SPACING, state.spacing + 0.01) });
		showInfo(`Spacing: ${state.spacing.toFixed(2)}`);
	},
	'Shift+KeyU': () => {
		setState({ spacing: Math.max(MIN_SPACING, state.spacing - 0.01) });
		showInfo(`Spacing: ${state.spacing.toFixed(2)}`);
	},
	KeyZ: () => {
		zoomTween.stop();
		if (isPreciseNavigationActive()) {
			setZoomState(MAX_ZOOM_EXPONENT, { syncSmoothed: true, persist: true });
			return;
		}
		setZoomState(MAX_ZOOM_EXPONENT, { syncSmoothed: false, persist: true });
		zoomTween.to([MAX_ZOOM_EXPONENT], 20000).startFromCurrentValues();
	},
	'Shift+KeyZ': () => {
		zoomTween.stop();
		if (isPreciseNavigationActive()) {
			setZoomState(MIN_ZOOM_EXPONENT, { syncSmoothed: true, persist: true });
			return;
		}
		setZoomState(MIN_ZOOM_EXPONENT, { syncSmoothed: false, persist: true });
		zoomTween.to([MIN_ZOOM_EXPONENT], 20000).startFromCurrentValues();
	},
	KeyX: resetState,
	ArrowUp: () => {
		translateViewCenter(0, 0.005);
	},
	'Shift+ArrowUp': () => {
		translateViewCenter(0, 0.05);
	},
	ArrowDown: () => {
		translateViewCenter(0, -0.005);
	},
	'Shift+ArrowDown': () => {
		translateViewCenter(0, -0.05);
	},
	ArrowLeft: () => {
		translateViewCenter(-0.005, 0);
	},
	'Shift+ArrowLeft': () => {
		translateViewCenter(-0.05, 0);
	},
	ArrowRight: () => {
		translateViewCenter(0.005, 0);
	},
	'Shift+ArrowRight': () => {
		translateViewCenter(0.05, 0);
	},
	Space: () => {
		setState({ isPlaying: 1 - state.isPlaying });
		showInfo(state.isPlaying ? 'Playing' : 'Paused');
	},
	'Shift+Space': () => {
		setState({ animationDirection: state.animationDirection * -1 });
	},
	'Shift+?': () => {
		instructionsContainer.classList.toggle('show');
	},
	Enter: () => {
		if (!activeRenderer) return;
		save(activeRenderer, 'fractal-export.png', null, { preventShare: true });
	},
	Escape: () => {
		instructionsContainer.classList.remove('show');
	},
});

const [state, shortKeys, stateParsers] = Object.entries({
	paletteId: [paletteIds[0], 'C'],
	animationDirection: [1, 'D', parseNumber],
	exponent: [2, 'E', parseNumber],
	fractalType: [0, 'F', parseNumber],
	colorScale: [0.2, 'G', parseNumber],
	forceHelp: [0, 'H', parseNumber],
	cImaginary: [-0.43, 'I', parseNumber],
	slopeShading: [1, 'K', parseNumber],
	isPlaying: [1, 'P', parseNumber],
	escapeRadius: [2, 'Q', parseNumber],
	cReal: [-0.71, 'R', parseNumber],
	speed: [1, 'S', parseNumber],
	transitionSmoothing: [1, 'T', parseNumber],
	spacing: [0.2, 'U', parseNumber],
	deepCenterReal: ['0', 'A'],
	deepCenterImag: ['0', 'B'],
	deepRadius: ['2', 'W'],
	xPosition: [0, 'X', parseNumber],
	yPosition: [0, 'Y', parseNumber],
	zoom: [MIN_ZOOM_EXPONENT, 'Z', parseNumber],
}).reduce(
	([nextState, nextShortKeys, nextStateParsers], [key, [value, shortKey, parser]]) => {
		nextState[key] = value;
		nextShortKeys[key] = shortKey;
		nextStateParsers[key] = parser ?? identity;
		return [nextState, nextShortKeys, nextStateParsers];
	},
	[{}, {}, {}],
);
const defaultState = { ...state };

function getApproximatePositionFromCenterComponent(centerComponent) {
	const numericValue = Number(centerComponent);
	return Number.isFinite(numericValue) ? numericValue / 2 : null;
}

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

function normalizeDecimalString(sign, integerPart, fractionalPart) {
	const normalizedInteger = integerPart.replace(/^0+(?=\d)/, '') || '0';
	const normalizedFraction = fractionalPart.replace(/0+$/, '');
	if (normalizedInteger === '0' && normalizedFraction === '') return '0';
	return `${sign}${normalizedInteger}${normalizedFraction ? `.${normalizedFraction}` : ''}`;
}

function roundPlainDecimalStringToFractionDigits(value, fractionDigits) {
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

function getUrlCenterFractionDigits(zoom) {
	if (!Number.isFinite(zoom)) return 17;
	const radiusDecimalDigits = Math.max(0, Math.ceil((zoom - 1) * Math.log10(2)));
	return radiusDecimalDigits + URL_CENTER_GUARD_DECIMAL_DIGITS;
}

function serializeStateValueForHash(key, value, urlCenterFractionDigits) {
	switch (key) {
		case 'deepCenterReal':
		case 'deepCenterImag':
			return roundPlainDecimalStringToFractionDigits(value, urlCenterFractionDigits);
		default:
			return value;
	}
}

function syncApproximateCenterFromPreciseState({ syncSmoothed = false } = {}) {
	const approximateX = getApproximatePositionFromCenterComponent(state.deepCenterReal);
	const approximateY = getApproximatePositionFromCenterComponent(state.deepCenterImag);
	if (approximateX !== null) {
		state.xPosition = approximateX;
		if (syncSmoothed) smoothedPosition[0] = approximateX;
	}
	if (approximateY !== null) {
		state.yPosition = approximateY;
		if (syncSmoothed) smoothedPosition[1] = approximateY;
	}
}

function syncPreciseCenterFromApproximateState() {
	state.deepCenterReal = (state.xPosition * 2).toString();
	state.deepCenterImag = (state.yPosition * 2).toString();
}

function getRadiusExactForZoom(zoom) {
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

function getApproximateZoomScale(zoom) {
	const zoomScale = Math.pow(2, zoom);
	return Number.isFinite(zoomScale) ? zoomScale : Number.MAX_VALUE;
}

function getCurrentRadiusExact() {
	return Math.abs(smoothedZoom[0] - state.zoom) < 1e-9 ? state.deepRadius : getRadiusExactForZoom(smoothedZoom[0]);
}

function syncPreciseRadiusFromApproximateZoom() {
	state.deepRadius = getRadiusExactForZoom(state.zoom);
}

function setApproximateCenterState(xPosition, yPosition, { syncSmoothed = false, persist = true } = {}) {
	const didChangeCenter =
		Math.abs(state.xPosition - xPosition) > 1e-15 || Math.abs(state.yPosition - yPosition) > 1e-15;
	state.xPosition = xPosition;
	state.yPosition = yPosition;
	syncPreciseCenterFromApproximateState();
	if (syncSmoothed) {
		smoothedPosition[0] = xPosition;
		smoothedPosition[1] = yPosition;
	}
	if (didChangeCenter && isDeepInteractionMotionWanted()) {
		beginDeepInteractionMotion();
	}
	if (persist) persistStateToHash();
}

function setPreciseCenterState(centerReal, centerImag, { syncSmoothed = false, persist = true } = {}) {
	const didChangeCenter = state.deepCenterReal !== centerReal || state.deepCenterImag !== centerImag;
	state.deepCenterReal = centerReal;
	state.deepCenterImag = centerImag;
	syncApproximateCenterFromPreciseState({ syncSmoothed });
	if (didChangeCenter && isDeepInteractionMotionWanted()) {
		beginDeepInteractionMotion();
	}
	if (persist) persistStateToHash();
}

function isPreciseNavigationActive(zoom = state.zoom) {
	return deepZoomManager.supportsState(state).supported && isDeepZoomRequested(zoom);
}

function setZoomState(zoom, { syncSmoothed = true, persist = true } = {}) {
	const didChangeZoom = Math.abs(state.zoom - zoom) > 1e-9;
	state.zoom = zoom;
	syncPreciseRadiusFromApproximateZoom();
	if (syncSmoothed) {
		smoothedZoom[0] = zoom;
	}
	if (didChangeZoom && isDeepInteractionMotionWanted(zoom)) {
		beginDeepInteractionMotion();
	}
	if (persist) persistStateToHash();
}

function translatePreciseCenter(deltaReal, deltaImag, radiusExact = state.deepRadius) {
	if (!deepZoomManager.isInitialized) {
		initializeDeepZoom();
		return false;
	}

	const translatedCenter = deepZoomManager.translateCenter(
		state.deepCenterReal,
		state.deepCenterImag,
		radiusExact,
		deltaReal,
		deltaImag,
	);
	setPreciseCenterState(translatedCenter.centerReal, translatedCenter.centerImag, { syncSmoothed: true });
	return true;
}

function translateViewCenter(deltaReal, deltaImag) {
	if (translatePreciseCenter(deltaReal, deltaImag, getCurrentRadiusExact())) {
		positionTween.stop();
		positionTween.to([state.xPosition, state.yPosition], 0).end();
		return true;
	}

	setApproximateCenterState(
		smoothedPosition[0] + deltaReal / Math.pow(2, smoothedZoom[0]),
		smoothedPosition[1] + deltaImag / Math.pow(2, smoothedZoom[0]),
		{ syncSmoothed: true },
	);
	positionTween.stop();
	positionTween.to([state.xPosition, state.yPosition], 0).end();
	return false;
}

function resetState() {
	Object.assign(state, defaultState);
	smoothedPosition[0] = state.xPosition;
	smoothedPosition[1] = state.yPosition;
	smoothedZoom[0] = state.zoom;
	paletteIdx = 0;
	updateColors(0);
	deepZoomManager.invalidate('reset');
	lastDeepIterationRenderSignature = null;
	lastUploadedDeepOrbitSignature = null;
	lastObservedZoom = smoothedZoom[0];
	settleDeepInteractionMotion.clearTimeout();
	setDeepInteractionInMotion(false);
	updateHash('');
}

function setState(diff) {
	let didUpdate = false;
	let hasApproximateCenterDiff = false;
	let hasPreciseCenterDiff = false;
	let hasZoomDiff = false;
	let hasPreciseRadiusDiff = false;
	Object.entries(diff).forEach(([key, value]) => {
		if (!(key in state)) {
			showError(`Invalid state key: ${key}`);
			return;
		}
		didUpdate = true;
		if (key === 'xPosition' || key === 'yPosition') hasApproximateCenterDiff = true;
		if (key === 'deepCenterReal' || key === 'deepCenterImag') hasPreciseCenterDiff = true;
		if (key === 'zoom') hasZoomDiff = true;
		if (key === 'deepRadius') hasPreciseRadiusDiff = true;
		state[key] = value;
	});

	if (!didUpdate) return;
	if (hasPreciseCenterDiff) {
		syncApproximateCenterFromPreciseState();
	} else if (hasApproximateCenterDiff) {
		syncPreciseCenterFromApproximateState();
	}
	if (hasZoomDiff && !hasPreciseRadiusDiff) {
		syncPreciseRadiusFromApproximateZoom();
	}
	persistStateToHash();
}

const persistStateToHash = debounce(function persistStateToHash() {
	const urlCenterFractionDigits = getUrlCenterFractionDigits(state.zoom);
	updateHash(
		Object.entries(state)
			.map(
				([key, value]) =>
					`${shortKeys[key]}=${encodeURIComponent(serializeStateValueForHash(key, value, urlCenterFractionDigits))}`,
			)
			.join('_'),
	);
}, 200);

function updateStateFromHash() {
	const hash = location.hash.substring(1);
	try {
		let hasApproximateCenterState = false;
		let hasPreciseCenterState = false;
		let hasPreciseRadiusState = false;
		const entries = hash
			.split('_')
			.map(str => {
				if (!str) return null;

				const [shortKey, encodedValue] = str.split('=');
				if (shortKey === 'M' || shortKey === 'J' || shortKey === 'N') {
					return null;
				}
				const key = Object.keys(shortKeys).find(k => shortKeys[k] === shortKey);
				if (!key) {
					showError(`Invalid URL short key: ${shortKey}`);
					return null;
				}
				const parser = stateParsers[key];
				const value = parser(decodeURIComponent(encodedValue));
				return [key, value];
			})
			.filter(Boolean);
		entries.forEach(([key, value]) => {
			state[key] = value;
			switch (key) {
				case 'deepCenterReal':
				case 'deepCenterImag':
					hasPreciseCenterState = true;
					break;
				case 'deepRadius':
					hasPreciseRadiusState = true;
					break;
				case 'xPosition':
					hasApproximateCenterState = true;
					smoothedPosition[0] = value;
					break;
				case 'yPosition':
					hasApproximateCenterState = true;
					smoothedPosition[1] = value;
					break;
				case 'zoom':
					smoothedZoom[0] = value;
					break;
				case 'paletteId':
					paletteIdx = paletteIds.indexOf(value);
					updateColors(0);
					break;
			}
		});
		if (hasPreciseCenterState) {
			syncApproximateCenterFromPreciseState({ syncSmoothed: true });
		} else if (hasApproximateCenterState) {
			syncPreciseCenterFromApproximateState();
		}
		if (!hasPreciseRadiusState) {
			syncPreciseRadiusFromApproximateZoom();
		}

		return entries.length;
	} catch (e) {
		console.error('Error parsing the hash', e);
	}
}

let showLabels = true;
let paletteIdx = paletteIds.indexOf(state.paletteId);

const smoothedZoom = [state.zoom];
const smoothedPosition = [state.xPosition, state.yPosition];
const positionTween = new Tween(smoothedPosition).easing(Easing.Quadratic.InOut);
const zoomTween = new Tween(smoothedZoom).easing(Easing.Quadratic.InOut);
let lastObservedZoom = smoothedZoom[0];

let hideErrorTimeout;
const errorContainer = document.getElementById('error');
function showError(err) {
	clearTimeout(hideErrorTimeout);
	errorContainer.classList.add('show');
	hideErrorTimeout = window.setTimeout(() => {
		errorContainer.classList.remove('show');
	}, 2000);
	if (err) {
		console.error(err);
	}
}

let hideInfoTimeout;
const infoContainer = document.getElementById('info');
function showInfo(text) {
	if (!showLabels) return;

	clearTimeout(hideInfoTimeout);
	infoContainer.textContent = text;
	infoContainer.classList.add('show');
	hideInfoTimeout = window.setTimeout(() => {
		infoContainer.classList.remove('show');
	}, 2000);
}

const canvas = createFullscreenCanvas(document.getElementById('canvas-container'));

const colors = new Float32Array(N_COLORS * 3);
function getColorUniformValue() {
	if (cachedColorUniformVersion === colorsVersion && cachedColorUniformValue) {
		return cachedColorUniformValue;
	}
	const uniformValue = new Array(N_COLORS);
	for (let i = 0; i < N_COLORS; i++) {
		const offset = i * 3;
		uniformValue[i] = [colors[offset], colors[offset + 1], colors[offset + 2]];
	}
	cachedColorUniformValue = uniformValue;
	cachedColorUniformVersion = colorsVersion;
	return uniformValue;
}

function updateColors(direction = 0) {
	paletteIdx = (paletteIds.length + paletteIdx + direction) % paletteIds.length;
	const paletteId = paletteIds[paletteIdx];
	const palette = palettes[paletteId];
	if (direction) setState({ paletteId: paletteId });

	const normalizedPalette = palette.map(hexToNormalizedRGB);
	for (let i = 0; i < N_COLORS; ++i) {
		const rgbComponents = [...normalizedPalette[i % normalizedPalette.length]];
		if (i >= normalizedPalette.length) {
			for (let j = 0; j < rgbComponents.length; ++j) {
				rgbComponents[j] = Math.max(0, Math.min(1, rgbComponents[j] + Math.random() * 0.1 - 0.05));
			}
		}
		const offset = i * 3;
		colors[offset] = rgbComponents[0];
		colors[offset + 1] = rgbComponents[1];
		colors[offset + 2] = rgbComponents[2];
	}
	colorsVersion += 1;
	document.documentElement.style.backgroundColor = palette[0];
}

function getAnimationFrameOffset(time) {
	return state.isPlaying
		? (colors.length + ((time * state.animationDirection * state.speed) / 62.5) * state.spacing) % colors.length
		: 0;
}

function getShaderPadOptions(options = {}) {
	return {
		canvas,
		...options,
	};
}

function getCanvasDisplaySize() {
	const rect = canvas.getBoundingClientRect();
	return {
		width: rect.width || canvas.clientWidth || window.innerWidth,
		height: rect.height || canvas.clientHeight || window.innerHeight,
	};
}

function getDeepInteractionMotionResolutionFactor() {
	// Iteration cost scales linearly with pixel count, so to hold the cost
	// constant as the iteration budget grows, the pixel count needs to shrink
	// at the same rate (i.e. the linear resolution factor scales as
	// sqrt(reference / current)). Clamped to [MIN_FACTOR, 1] so it doesn't
	// upsample below the budget threshold or drop further than 1/3 at depth.
	const currentIterations = getIterationBudget(smoothedZoom[0]);
	if (currentIterations <= DEEP_INTERACTION_MOTION_FULL_RES_ITERATIONS) return 1;
	const factor = Math.sqrt(DEEP_INTERACTION_MOTION_FULL_RES_ITERATIONS / currentIterations);
	return Math.max(DEEP_INTERACTION_MOTION_MIN_FACTOR, factor);
}

function getEffectiveResolutionMultiplier() {
	if (!isDeepInteractionInMotion) return resolutionMultiplier;
	const motionFactor = getDeepInteractionMotionResolutionFactor();
	if (motionFactor >= 1) return resolutionMultiplier;
	return Math.max(MIN_RESOLUTION_MULTIPLIER, resolutionMultiplier * motionFactor);
}

function syncCanvasResolution() {
	const displaySize = getCanvasDisplaySize();
	const effectiveMultiplier = getEffectiveResolutionMultiplier();
	const width = Math.max(1, Math.round(displaySize.width * effectiveMultiplier));
	const height = Math.max(1, Math.round(displaySize.height * effectiveMultiplier));
	if (canvas.width === width && canvas.height === height) return;

	canvas.width = width;
	canvas.height = height;
}

function setDeepInteractionInMotion(isActive) {
	if (isDeepInteractionInMotion === isActive) return;
	isDeepInteractionInMotion = isActive;
	syncCanvasResolution();
}

const settleDeepInteractionMotion = debounce(() => {
	setDeepInteractionInMotion(false);
}, DEEP_INTERACTION_MOTION_SETTLE_MS);

function beginDeepInteractionMotion() {
	setDeepInteractionInMotion(true);
	settleDeepInteractionMotion();
}

function isDeepInteractionMotionWanted(zoom = smoothedZoom[0]) {
	return (
		deepZoomManager.supportsState(state).supported &&
		(isDeepZoomRequested(zoom) || isDeepZoomRequested(smoothedZoom[0]))
	);
}

function updateDeepInteractionMotion() {
	if (Math.abs(smoothedZoom[0] - lastObservedZoom) <= 1e-9) return;
	lastObservedZoom = smoothedZoom[0];
	if (isDeepInteractionMotionWanted()) {
		beginDeepInteractionMotion();
	}
}

function setResolutionMultiplier(nextResolutionMultiplier) {
	const clampedResolutionMultiplier = Math.max(
		MIN_RESOLUTION_MULTIPLIER,
		Math.min(MAX_RESOLUTION_MULTIPLIER, nextResolutionMultiplier),
	);
	if (clampedResolutionMultiplier === resolutionMultiplier) return;

	resolutionMultiplier = clampedResolutionMultiplier;
	syncCanvasResolution();
}

function initializeStandardRendererUniforms(renderState) {
	standardRenderer.initializeUniform('u_center', 'float', [renderState.xPosition, renderState.yPosition]);
	standardRenderer.initializeUniform('u_zoom', 'float', renderState.zoomScale);
	standardRenderer.initializeUniform('u_fractalType', 'int', renderState.fractalType);
	standardRenderer.initializeUniform('u_exponent', 'int', renderState.exponent);
	standardRenderer.initializeUniform('u_cReal', 'float', renderState.cReal);
	standardRenderer.initializeUniform('u_cImaginary', 'float', renderState.cImaginary);
	standardRenderer.initializeUniform('u_colors', 'float', getColorUniformValue(), { arrayLength: N_COLORS });
	standardRenderer.initializeUniform('u_transitionSmoothing', 'int', renderState.transitionSmoothing);
	standardRenderer.initializeUniform('u_escapeRadius', 'float', renderState.escapeRadius);
	standardRenderer.initializeUniform('u_logEscapeRadius', 'float', renderState.logEscapeRadius);
	standardRenderer.initializeUniform('u_colorScale', 'float', renderState.colorScale);
	standardRenderer.initializeUniform('u_paletteFrame', 'float', renderState.paletteFrame);
	standardRenderer.initializeUniform('u_iterations', 'int', renderState.iterations);
	standardRenderer.initializeUniform('u_slopeShading', 'int', renderState.slopeShading);
}

function ensureStandardRenderer(renderState) {
	if (standardRenderer) return;
	standardRenderer = new ShaderPad(fragmentSource, getShaderPadOptions());
	initializeStandardRendererUniforms(renderState);
	standardRendererColorsVersion = colorsVersion;
}

function updateStandardRendererUniforms(renderState) {
	const uniformUpdates = {
		u_center: [renderState.xPosition, renderState.yPosition],
		u_zoom: renderState.zoomScale,
		u_fractalType: renderState.fractalType,
		u_exponent: renderState.exponent,
		u_cReal: renderState.cReal,
		u_cImaginary: renderState.cImaginary,
		u_transitionSmoothing: renderState.transitionSmoothing,
		u_escapeRadius: renderState.escapeRadius,
		u_logEscapeRadius: renderState.logEscapeRadius,
		u_colorScale: renderState.colorScale,
		u_paletteFrame: renderState.paletteFrame,
		u_iterations: renderState.iterations,
		u_slopeShading: renderState.slopeShading,
	};

	if (standardRendererColorsVersion !== colorsVersion) {
		uniformUpdates.u_colors = getColorUniformValue();
		standardRendererColorsVersion = colorsVersion;
	}

	standardRenderer.updateUniforms(uniformUpdates);
}

function decomposeRadiusExact(radiusExact, fallbackRadius) {
	if (deepZoomManager.isInitialized) {
		const [mantissa, exponent] = deepZoomManager.decomposeValue(radiusExact);
		return { mantissa, exponent };
	}

	if (fallbackRadius === 0) {
		return { mantissa: 0, exponent: 0 };
	}

	const exponent = Math.floor(Math.log2(Math.abs(fallbackRadius))) + 1;
	return {
		mantissa: fallbackRadius / Math.pow(2, exponent),
		exponent,
	};
}

function getDeepShaderUniforms(renderState) {
	const { mantissa, exponent } = decomposeRadiusExact(renderState.radiusExact, renderState.radius);
	// The polynomial uniforms are rebuilt against the current view radius (mantissa,
	// exponent) on each call. Reusing the radius captured at reference-compute time
	// would otherwise drift the shape as the user zooms within a single reference orbit.
	const referenceUniforms = deepZoomManager.getShaderUniforms(mantissa, exponent);
	const referenceOffset = deepZoomManager.getReferenceOffsetFor(renderState);
	return {
		u_orbitLength: referenceUniforms?.u_orbitLength ?? 0,
		u_radiusMantissa: mantissa,
		u_radiusExponent: exponent,
		u_referenceOffset: [referenceOffset?.offsetReal ?? 0, referenceOffset?.offsetImag ?? 0],
		u_poly1: referenceUniforms?.u_poly1 ?? [0, 0, 0, 0],
		u_poly2: referenceUniforms?.u_poly2 ?? [0, 0],
		u_polynomialLimit: referenceUniforms?.u_polynomialLimit ?? 0,
		u_polyScaleExponent: referenceUniforms?.u_polyScaleExponent ?? 0,
	};
}

function canRenderFromCurrentDeepReference(renderState) {
	if (!deepZoomManager.hasCompatibleReferenceFor(renderState)) return false;
	const referenceOffset = deepZoomManager.getReferenceOffsetFor(renderState);
	if (!referenceOffset) return false;
	const maxOffset = Math.max(Math.abs(referenceOffset.offsetReal), Math.abs(referenceOffset.offsetImag));
	return Number.isFinite(maxOffset) && maxOffset <= DEEP_COMPATIBLE_REFERENCE_MAX_OFFSET;
}

function shouldRecenterDeepReference(renderState) {
	if (!canRenderFromCurrentDeepReference(renderState)) return true;
	// hasCompatibleReferenceFor no longer rejects on iteration count (so the deep
	// renderer keeps drawing during a recompute instead of flashing standard), but
	// we still need a recompute when the budget outgrows the existing orbit, since
	// the strict-signature and offset checks below otherwise wouldn't catch it.
	if (deepZoomManager.referenceIterationsBelow(renderState)) return true;
	if (deepZoomManager.hasReferenceFor(renderState)) return false;
	const referenceOffset = deepZoomManager.getReferenceOffsetFor(renderState);
	if (!referenceOffset) return true;
	const maxOffset = Math.max(Math.abs(referenceOffset.offsetReal), Math.abs(referenceOffset.offsetImag));
	return !Number.isFinite(maxOffset) || maxOffset > DEEP_REFERENCE_RECENTER_OFFSET;
}

function getIterationBudget(zoom) {
	// One shared budget for both renderers. A discontinuous jump at the deep
	// threshold (256 → 2048+) would flip every slow-escape pixel from "in-set"
	// (rendered dark) to "escaped" (rendered with the palette) right at the
	// boundary, so we ramp continuously from BASE_ITERATIONS up to
	// DEEP_MIN_ITERATIONS as zoom approaches DEEP_ZOOM_THRESHOLD, then keep
	// growing with the existing per-zoom-level factor beyond the threshold.
	const depthFromBase = Math.max(0, zoom - MIN_ZOOM_EXPONENT);
	const depthFromThreshold = Math.max(0, zoom - DEEP_ZOOM_THRESHOLD);
	const preThresholdSpan = Math.max(1e-9, DEEP_ZOOM_THRESHOLD - MIN_ZOOM_EXPONENT);
	const preThresholdRatio = Math.min(1, depthFromBase / preThresholdSpan);
	const preThresholdBudget = BASE_ITERATIONS + preThresholdRatio * (DEEP_MIN_ITERATIONS - BASE_ITERATIONS);
	const postThresholdBudget = depthFromThreshold * DEEP_ITERATION_ZOOM_FACTOR;
	const target = preThresholdBudget + postThresholdBudget;
	const quantized = Math.ceil(target / DEEP_ITERATION_QUANTUM) * DEEP_ITERATION_QUANTUM;
	return Math.min(DEEP_MAX_ITERATIONS, Math.max(BASE_ITERATIONS, quantized));
}

function initializeDeepIterationUniforms(renderState) {
	const deepUniforms = getDeepShaderUniforms(renderState);
	deepIterationRenderer.initializeUniform('u_iterations', 'int', renderState.deepIterations);
	deepIterationRenderer.initializeUniform('u_orbitLength', 'int', deepUniforms.u_orbitLength);
	deepIterationRenderer.initializeUniform('u_fractalType', 'int', renderState.fractalType);
	deepIterationRenderer.initializeUniform('u_radiusMantissa', 'float', deepUniforms.u_radiusMantissa);
	deepIterationRenderer.initializeUniform('u_radiusExponent', 'int', deepUniforms.u_radiusExponent);
	deepIterationRenderer.initializeUniform('u_referenceOffset', 'float', deepUniforms.u_referenceOffset);
	deepIterationRenderer.initializeUniform('u_transitionSmoothing', 'int', renderState.transitionSmoothing);
	deepIterationRenderer.initializeUniform('u_escapeRadius', 'float', renderState.escapeRadius);
	deepIterationRenderer.initializeUniform('u_logEscapeRadius', 'float', renderState.logEscapeRadius);
	deepIterationRenderer.initializeUniform('u_slopeShading', 'int', renderState.slopeShading);
	deepIterationRenderer.initializeUniform('u_seriesApproximation', 'int', renderState.seriesApproximation);
	deepIterationRenderer.initializeUniform('u_poly1', 'float', deepUniforms.u_poly1);
	deepIterationRenderer.initializeUniform('u_poly2', 'float', deepUniforms.u_poly2);
	deepIterationRenderer.initializeUniform('u_polynomialLimit', 'int', deepUniforms.u_polynomialLimit);
	deepIterationRenderer.initializeUniform('u_polyScaleExponent', 'int', deepUniforms.u_polyScaleExponent);
}

function updateDeepIterationUniforms(renderState) {
	const deepUniforms = getDeepShaderUniforms(renderState);
	// Polynomial uniforms used to be uploaded only when the reference orbit changed,
	// but they're now radius-dependent (rebuilt each frame in deepZoom.getShaderUniforms
	// so the SA warm start matches the current view), so we upload them unconditionally.
	// Cost is six floats + two ints per frame, negligible vs the iteration shader work.
	deepIterationRenderer.updateUniforms({
		u_iterations: renderState.deepIterations,
		u_orbitLength: deepUniforms.u_orbitLength,
		u_fractalType: renderState.fractalType,
		u_radiusMantissa: deepUniforms.u_radiusMantissa,
		u_radiusExponent: deepUniforms.u_radiusExponent,
		u_referenceOffset: deepUniforms.u_referenceOffset,
		u_transitionSmoothing: renderState.transitionSmoothing,
		u_escapeRadius: renderState.escapeRadius,
		u_logEscapeRadius: renderState.logEscapeRadius,
		u_slopeShading: renderState.slopeShading,
		u_seriesApproximation: renderState.seriesApproximation,
		u_poly1: deepUniforms.u_poly1,
		u_poly2: deepUniforms.u_poly2,
		u_polynomialLimit: deepUniforms.u_polynomialLimit,
		u_polyScaleExponent: deepUniforms.u_polyScaleExponent,
	});
}

function syncDeepOrbitTexture() {
	if (!deepIterationRenderer) return;

	const orbitTextureSource = deepZoomManager.getOrbitTextureSource();
	if (!orbitTextureSource) return;

	if (lastUploadedDeepOrbitSignature === deepZoomManager.referenceSignature) return;

	if (lastUploadedDeepOrbitSignature === null) {
		deepIterationRenderer.initializeTexture('u_orbitTexture', orbitTextureSource, ORBIT_TEXTURE_OPTIONS);
	} else {
		deepIterationRenderer.updateTextures({ u_orbitTexture: orbitTextureSource });
	}

	lastUploadedDeepOrbitSignature = deepZoomManager.referenceSignature;
}

function ensureDeepIterationRenderer(renderState) {
	if (deepIterationRenderer) return;

	deepIterationRenderer = new ShaderPad(generatePerturbationShader(), {
		...getShaderPadOptions(),
		...METRIC_TEXTURE_OPTIONS,
	});
	lastDeepIterationRenderSignature = null;
	initializeDeepIterationUniforms(renderState);
	syncDeepOrbitTexture();
}

function initializeDeepDisplayUniforms(renderState) {
	deepDisplayRenderer.initializeUniform('u_colors', 'float', getColorUniformValue(), { arrayLength: N_COLORS });
	deepDisplayRenderer.initializeUniform('u_paletteFrame', 'float', renderState.paletteFrame);
	deepDisplayRenderer.initializeUniform('u_colorScale', 'float', renderState.colorScale);
	deepDisplayRenderer.initializeTexture('u_liveMetrics', deepIterationRenderer);
}

function ensureDeepDisplayRenderer(renderState) {
	if (deepDisplayRenderer) return;
	ensureDeepIterationRenderer(renderState);
	deepDisplayRenderer = new ShaderPad(generateDeepDisplayShader(), getShaderPadOptions());
	initializeDeepDisplayUniforms(renderState);
	deepDisplayRendererColorsVersion = colorsVersion;
}

function updateDeepDisplayUniforms(renderState) {
	const uniformUpdates = {
		u_paletteFrame: renderState.paletteFrame,
		u_colorScale: renderState.colorScale,
	};

	if (deepDisplayRendererColorsVersion !== colorsVersion) {
		uniformUpdates.u_colors = getColorUniformValue();
		deepDisplayRendererColorsVersion = colorsVersion;
	}

	deepDisplayRenderer.updateUniforms(uniformUpdates);
}

function initializeDeepZoom() {
	deepZoomManager.initialize().catch(error => {
		showError('Failed to initialize deep zoom');
		console.error(error);
	});
}

function isDeepZoomRequested(zoom) {
	return zoom > STANDARD_RENDER_SAFE_ZOOM_EXPONENT || deepZoomManager.shouldUseDeepZoom(zoom);
}

function getRenderState(time) {
	const zoomScale = getApproximateZoomScale(smoothedZoom[0]);
	const centerRealExact = state.deepCenterReal;
	const centerImagExact = state.deepCenterImag;
	const radiusExact = getCurrentRadiusExact();
	const approximateCenterReal = Number(centerRealExact);
	const approximateCenterImag = Number(centerImagExact);
	const approximateRadius = Number(radiusExact);
	const fallbackRadius = Math.pow(2, 1 - smoothedZoom[0]);
	const fullIterations = getIterationBudget(smoothedZoom[0]);
	// Iterations are not capped during interaction; instead the canvas is resized
	// down (see getDeepInteractionMotionResolutionFactor / syncCanvasResolution)
	// so the iteration shader does less per-frame work but stays correct.
	const iterations = fullIterations;
	const renderState = {
		xPosition: smoothedPosition[0],
		yPosition: smoothedPosition[1],
		centerReal: Number.isFinite(approximateCenterReal) ? approximateCenterReal : smoothedPosition[0] * 2,
		centerImag: Number.isFinite(approximateCenterImag) ? approximateCenterImag : smoothedPosition[1] * 2,
		centerRealExact,
		centerImagExact,
		zoom: smoothedZoom[0],
		zoomScale,
		radius: Number.isFinite(approximateRadius) && approximateRadius > 0 ? approximateRadius : fallbackRadius,
		radiusExact,
		paletteFrame: getAnimationFrameOffset(time),
		fractalType: state.fractalType,
		exponent: state.exponent,
		cReal: state.cReal,
		cImaginary: state.cImaginary,
		iterations,
		deepIterations: iterations,
		fullIterations,
		transitionSmoothing: state.transitionSmoothing,
		escapeRadius: state.escapeRadius,
		logEscapeRadius: Math.log(state.escapeRadius),
		colorScale: Math.max(MIN_COLOR_SCALE, Math.min(MAX_COLOR_SCALE, state.colorScale)),
		spacing: state.spacing,
		slopeShading: state.slopeShading,
		seriesApproximation: 1,
	};
	return renderState;
}

function maybeShowUnsupportedDeepZoomNotice(requested, support) {
	if (!requested || support.supported) {
		lastUnsupportedDeepZoomReason = null;
		return;
	}

	if (lastUnsupportedDeepZoomReason === support.reason) return;
	lastUnsupportedDeepZoomReason = support.reason;
	showInfo(support.reason);
}

function maybeShowDeepZoomModeNotice(requestedDeepZoom, support) {
	// Track the user's intent (deep zoom requested and supported) rather than the
	// active renderer mode, which can briefly fall back to standard while a new
	// reference orbit is being computed and would otherwise re-fire this notice.
	const isDeepActive = requestedDeepZoom && support.supported;
	if (lastDeepZoomActive === isDeepActive) return;
	if (isDeepActive) {
		showInfo('Deep zoom mode enabled');
	} else if (lastDeepZoomActive) {
		showInfo('Standard zoom mode');
	}
	lastDeepZoomActive = isDeepActive;
}

function shouldPrepareDeepZoom(zoom) {
	return zoom > DEEP_ZOOM_THRESHOLD - DEEP_ZOOM_PREPARATION_MARGIN_EXPONENT;
}

function getReferenceIterationCount(zoom, currentFullIterations) {
	// Compute the orbit with enough iterations to cover both the threshold crossing
	// and a few zoom units beyond, so the same orbit can be reused without an
	// immediate recompute as the user keeps zooming in.
	const headroomZoom = Math.max(zoom, DEEP_ZOOM_THRESHOLD) + DEEP_REFERENCE_ITERATION_HEADROOM_EXPONENT;
	return Math.max(currentFullIterations, getIterationBudget(headroomZoom));
}

function ensureDeepZoomPreparation(renderState, requested, support) {
	const shouldPrepare = requested || shouldPrepareDeepZoom(renderState.zoom);
	if (!shouldPrepare) return;
	if (!deepZoomManager.isInitialized) {
		initializeDeepZoom();
		return;
	}
	if (!support.supported) return;
	// Replacing in-flight references during continuous zoom can starve the first deep render.
	if (deepZoomManager.pendingReferencePromise) return;

	// Always target the full iteration budget for the reference orbit, even if
	// the per-frame iteration shader runs at reduced resolution during motion.
	// We want the orbit to be ready for full-quality rendering the moment the
	// user stops zooming.
	const referenceIterations = getReferenceIterationCount(renderState.zoom, renderState.fullIterations);
	const referenceTargetState = { ...renderState, deepIterations: referenceIterations };

	if (!shouldRecenterDeepReference(referenceTargetState)) return;

	deepZoomManager.ensureReference(referenceTargetState).catch(error => {
		showError('Failed to compute deep zoom reference');
		console.error(error);
	});
}

function getDeepIterationRenderSignature(renderState) {
	const referenceOffset = deepZoomManager.getReferenceOffsetFor(renderState);
	return [
		deepZoomManager.referenceSignature ?? '',
		renderState.centerRealExact,
		renderState.centerImagExact,
		renderState.radiusExact,
		referenceOffset?.offsetReal?.toPrecision(12) ?? '0',
		referenceOffset?.offsetImag?.toPrecision(12) ?? '0',
		renderState.deepIterations,
		renderState.transitionSmoothing,
		renderState.escapeRadius.toPrecision(12),
		renderState.logEscapeRadius.toPrecision(12),
		renderState.fractalType,
		renderState.exponent,
		renderState.cReal.toPrecision(12),
		renderState.cImaginary.toPrecision(12),
		renderState.slopeShading,
		renderState.seriesApproximation,
		canvas.width,
		canvas.height,
	].join('|');
}

function renderDeepTargetState(targetState) {
	updateDeepIterationUniforms(targetState);
	syncDeepOrbitTexture();
	deepIterationRenderer.step();
	deepDisplayRenderer.updateTextures({ u_liveMetrics: deepIterationRenderer });
	lastDeepIterationRenderSignature = getDeepIterationRenderSignature(targetState);
}

function renderDeepPipeline(renderState) {
	ensureDeepIterationRenderer(renderState);
	ensureDeepDisplayRenderer(renderState);

	const targetSignature = getDeepIterationRenderSignature(renderState);
	if (lastDeepIterationRenderSignature !== targetSignature) {
		renderDeepTargetState(renderState);
	}

	updateDeepDisplayUniforms(renderState);
	deepDisplayRenderer.draw();
}

function render(time) {
	zoomTween.update(time);
	updateDeepInteractionMotion();
	syncCanvasResolution();

	if (isPreciseNavigationActive(smoothedZoom[0])) {
		positionTween.stop();
		smoothedPosition[0] = state.xPosition;
		smoothedPosition[1] = state.yPosition;
	} else {
		positionTween.update(time);
	}

	const renderState = getRenderState(time);
	const requestedDeepZoom = isDeepZoomRequested(renderState.zoom);
	const deepZoomSupport = deepZoomManager.supportsState(state);
	ensureDeepZoomPreparation(renderState, requestedDeepZoom, deepZoomSupport);
	maybeShowUnsupportedDeepZoomNotice(requestedDeepZoom, deepZoomSupport);

	const canRenderDeep =
		requestedDeepZoom && deepZoomSupport.supported && canRenderFromCurrentDeepReference(renderState);

	if (canRenderDeep) {
		renderDeepPipeline(renderState);
		activeRenderer = deepDisplayRenderer;
	} else {
		ensureStandardRenderer(renderState);
		updateStandardRendererUniforms(renderState);
		standardRenderer.draw();
		activeRenderer = standardRenderer;
	}

	maybeShowDeepZoomModeNotice(requestedDeepZoom, deepZoomSupport);
	requestAnimationFrame(render);
}

const instructionsContainer = document.getElementById('instructions');
instructionsContainer.querySelector('.start-button').addEventListener('click', () => {
	instructionsContainer.classList.remove('show');
});

const showInstructionsButton = document.getElementById('show-instructions');
showInstructionsButton.addEventListener('click', () => {
	showInstructionsButton.classList.remove('show');
	instructionsContainer.classList.add('show');
});

const desktopControlsContainer = document.getElementById('desktop-controls');
const touchControlsContainer = document.getElementById('touch-controls');
document.getElementById('show-touch-controls').addEventListener('click', () => {
	desktopControlsContainer.classList.remove('show');
	touchControlsContainer.classList.add('show');
});
document.getElementById('show-desktop-controls').addEventListener('click', () => {
	touchControlsContainer.classList.remove('show');
	desktopControlsContainer.classList.add('show');
});
if (window.matchMedia('(pointer: coarse)').matches) {
	desktopControlsContainer.classList.remove('show');
	touchControlsContainer.classList.add('show');
}

window.addEventListener('hashchange', updateStateFromHash);

canvas.addEventListener('click', e => {
	const { left, top, width, height } = canvas.getBoundingClientRect();
	const aspectRatio = width / height;
	const clickX = e.clientX - left;
	const clickY = e.clientY - top;
	let normalizedX = (clickX / width) * 2 - 1;
	let normalizedY = -((clickY / height) * 2 - 1);
	if (aspectRatio > 1.0) {
		normalizedX *= aspectRatio;
	} else {
		normalizedY /= aspectRatio;
	}
	if (isPreciseNavigationActive(smoothedZoom[0])) {
		positionTween.stop();
		if (!translatePreciseCenter(normalizedX, normalizedY, getCurrentRadiusExact())) {
			setApproximateCenterState(
				smoothedPosition[0] + normalizedX / Math.pow(2, smoothedZoom[0]),
				smoothedPosition[1] + normalizedY / Math.pow(2, smoothedZoom[0]),
				{ syncSmoothed: true },
			);
		}
		return;
	}
	const xPosition = smoothedPosition[0] + normalizedX / Math.pow(2, smoothedZoom[0]);
	const yPosition = smoothedPosition[1] + normalizedY / Math.pow(2, smoothedZoom[0]);
	positionTween.stop();
	setApproximateCenterState(xPosition, yPosition);
	positionTween.to([state.xPosition, state.yPosition], 1000).startFromCurrentValues();
});

canvas.addEventListener('wheel', e => {
	const delta = Math.sign(e.deltaY) * 0.05;
	zoomTween.stop();
	setZoomState(Math.max(MIN_ZOOM_EXPONENT, Math.min(MAX_ZOOM_EXPONENT, smoothedZoom[0] - delta)));
	zoomTween.to([state.zoom], 0).end();
});

handleTouch(canvas, (direction, delta, additionalFingers) => {
	if (additionalFingers === 0) {
		if (direction === 'x') {
			if (Math.abs(delta) < 32) return { skip: true };
			updateColors(Math.sign(delta));
		} else {
			zoomTween.stop();
			setZoomState(Math.max(MIN_ZOOM_EXPONENT, Math.min(MAX_ZOOM_EXPONENT, smoothedZoom[0] - delta * 0.05)));
			zoomTween.to([state.zoom], 0).end();
		}
	} else if (additionalFingers === 1) {
		// Do nothing. People tend to accidentally trigger this when they try
		// to pinch zoom, so it’s best to ignore two-fingered gestures.
	} else if (additionalFingers === 2) {
		if (direction === 'x') {
			setState({
				cReal: Math.max(-MAX_CONSTANT_COMPONENT, Math.min(MAX_CONSTANT_COMPONENT, state.cReal + delta * 0.01)),
			});
		} else {
			setState({
				cImaginary: Math.max(
					-MAX_CONSTANT_COMPONENT,
					Math.min(MAX_CONSTANT_COMPONENT, state.cImaginary + delta * 0.01),
				),
			});
		}
	} else if (additionalFingers === 3) {
		if (direction === 'x') {
			if (Math.abs(delta) < 32) return { skip: true };
			setState({ exponent: Math.max(MIN_EXPONENT, Math.min(MAX_EXPONENT, state.exponent + Math.sign(delta))) });
		} else {
			setState({
				escapeRadius: Math.max(
					MIN_ESCAPE_RADIUS,
					Math.min(MAX_ESCAPE_RADIUS, state.escapeRadius + delta * 0.01),
				),
			});
		}
	} else if (additionalFingers === 4) {
		if (direction === 'x') {
			if (Math.abs(delta) < 64) return { skip: true };
			setState({
				fractalType: (FRACTAL_TYPES.length + state.fractalType + Math.sign(delta)) % FRACTAL_TYPES.length,
			});
		} else {
			setState({ speed: Math.max(MIN_SPEED, Math.min(MAX_SPEED, state.speed - delta * 0.01)) });
		}
	}
});

const nStateUpdates = updateStateFromHash();
lastObservedZoom = smoothedZoom[0];
syncCanvasResolution();
updateColors(0);
requestAnimationFrame(render);

const shouldShowInstructions = nStateUpdates < 3 || state.forceHelp;
if (shouldShowInstructions) {
	instructionsContainer.classList.add('show');
} else {
	document.getElementById('show-instructions').classList.add('show');
}
