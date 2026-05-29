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
import * as profiler from './profiler.js';

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
const MIN_COLOR_SCALE = 0.02;
const MAX_COLOR_SCALE = 1.0;
const MIN_SLOPE_LIGHT_HEIGHT = 0.1;
const MAX_SLOPE_LIGHT_HEIGHT = 4;
const MIN_SLOPE_LIGHT_INTENSITY = 0;
const MAX_SLOPE_LIGHT_INTENSITY = 2;
const SLOPE_LIGHT_ANGLE_STEP = 5;
const SLOPE_LIGHT_HEIGHT_STEP = 0.1;
const SLOPE_LIGHT_INTENSITY_STEP = 0.05;
const MIN_SPEED = 0.1;
const MAX_SPEED = 8;
const BASE_ITERATIONS = 256;
// Floor for the deep iteration budget. Picked high enough that the iteration
// range gives palette cycling room (low values cluster everything near the
// cap and the color range collapses). Per-frame shader cost is offset by the
// palette-texture optimization moving display:draw from ~5ms to <1ms.
const DEEP_MIN_ITERATIONS = 8192;
const DEEP_MAX_ITERATIONS = 65536;
const DEEP_ITERATION_ZOOM_FACTOR = 384;
const DEEP_COMPATIBLE_REFERENCE_MAX_OFFSET = 2.5;
// Threshold past which we recompute a closer reference. Pushed up against
// DEEP_COMPATIBLE_REFERENCE_MAX_OFFSET so a single reference stays in use much
// longer before a forced recompute. Each recompute is a visible jump (the
// reference center may shift via findGoodReferenceCenter, every pixel sees a
// different per-pixel perturbation result), so trading some perturbation
// accuracy at large offsets for fewer jumps reads as much smoother.
const DEEP_REFERENCE_RECENTER_OFFSET = 2.0;
const DEEP_SETTLED_REFERENCE_RECENTER_OFFSET = 1.0;
// Start computing the deep reference orbit this many zoom units before crossing the
// deep-zoom threshold so the orbit is ready by the time the user actually needs it.
const DEEP_ZOOM_PREPARATION_MARGIN_EXPONENT = 3;
// Reference orbit is computed with iterations sufficient for this many zoom units
// of headroom past the current zoom. With u_iterations now continuous and
// DEEP_REFERENCE_ITERATION_QUANTUM keeping the recompute trigger from firing every
// zoom unit, ~12 zoom units of headroom is enough to avoid visible recompute jumps
// during normal zooming while keeping reference-orbit GMP work bounded.
const DEEP_REFERENCE_ITERATION_HEADROOM_EXPONENT = 12;
// Coarse quantum applied to the reference-orbit iteration count so the trigger
// (stored < target) doesn't fire every zoom unit. Sized to cover several zoom
// units of u_iterations growth per recompute.
const DEEP_REFERENCE_ITERATION_QUANTUM = 4096;
const DEEP_INTERACTION_MOTION_SETTLE_MS = 200;
// Absolute pixel density (CSS-pixel multiplier) used while the user is interacting.
// Half of non-retina resolution — quartering the linear density on a 2x retina, so
// the iteration shader does ~16x less work per frame during zoom/pan.
const INTERACTION_MOTION_RESOLUTION_MULTIPLIER = 0.5;
const URL_CENTER_GUARD_DECIMAL_DIGITS = 6;
const SHOW_ZOOM_MODE_NOTICES = import.meta.env.DEV;

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

// 1D palette texture sampled by the display shader. SRGB8_ALPHA8 has the GPU
// decode each entry from sRGB to linear on sample, so LINEAR filtering blends
// adjacent entries in linear space — gamma-correct palette interpolation with
// no per-pixel pow() in the shader. REPEAT wrap makes the palette cycle
// seamlessly.
const PALETTE_TEXTURE_OPTIONS = {
	internalFormat: 'SRGB8_ALPHA8',
	format: 'RGBA',
	type: 'UNSIGNED_BYTE',
	minFilter: 'LINEAR',
	magFilter: 'LINEAR',
	wrapS: 'REPEAT',
	wrapT: 'CLAMP_TO_EDGE',
	preserveY: false,
};

const FRACTAL_TYPES = ['Julia', 'Mandelbrot', 'Burning Ship', 'Mandala'];

const MIN_ZOOM_EXPONENT = Math.log(MIN_ZOOM) / Math.log(2);
const MAX_ZOOM_EXPONENT = MAX_ZOOM_DECIMAL_EXPONENT / Math.log10(2);
const STANDARD_RENDER_SAFE_ZOOM_EXPONENT = Math.log(STANDARD_RENDER_SAFE_MAX_ZOOM) / Math.log(2);

const deepZoomManager = new DeepZoomManager({ threshold: DEEP_ZOOM_THRESHOLD });

let resolutionMultiplier = window.devicePixelRatio || 1;
let standardIterationRenderer = null;
let deepIterationRenderer = null;
let displayRenderer = null;
let lastStandardIterationRenderSignature = null;
let lastUploadedDeepOrbitSignature = null;
let lastDeepIterationRenderSignature = null;
let lastUnsupportedDeepZoomReason = null;
let lastDeepZoomActive = false;
let isDeepInteractionInMotion = false;
let colorsVersion = 0;
let displayRendererColorsVersion = -1;
let paletteFrame = 0;
let lastPaletteUpdateMs = null;
const PALETTE_SECONDS_PER_BAND = 0.3125;

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
	KeyJ: () => {
		updateSlopeLightIntensity(SLOPE_LIGHT_INTENSITY_STEP);
	},
	'Shift+KeyJ': () => {
		updateSlopeLightIntensity(-SLOPE_LIGHT_INTENSITY_STEP);
	},
	KeyK: () => {
		updateSlopeLightHeight(SLOPE_LIGHT_HEIGHT_STEP);
	},
	'Shift+KeyK': () => {
		updateSlopeLightHeight(-SLOPE_LIGHT_HEIGHT_STEP);
	},
	KeyL: () => {
		updateSlopeLightAngle(SLOPE_LIGHT_ANGLE_STEP);
	},
	'Shift+KeyL': () => {
		updateSlopeLightAngle(-SLOPE_LIGHT_ANGLE_STEP);
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
	KeyA: () => {
		setState({ stripeAverage: 1 - state.stripeAverage });
		showInfo(state.stripeAverage ? 'Stripe average coloring on' : 'Stripe average coloring off');
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
	KeyP: () => {
		const enabled = profiler.toggle();
		showInfo(enabled ? 'Profiler on' : 'Profiler off');
	},
	Enter: () => {
		if (!displayRenderer) return;
		save(displayRenderer, 'fractal.png', null, { preventShare: true });
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
	slopeLightAngle: [135, 'LA', parseNumber],
	slopeLightHeight: [1.5, 'LH', parseNumber],
	slopeLightIntensity: [1, 'LI', parseNumber],
	stripeAverage: [0, 'SA', parseNumber],
	isPlaying: [1, 'P', parseNumber],
	escapeRadius: [2, 'Q', parseNumber],
	cReal: [-0.71, 'R', parseNumber],
	speed: [1, 'S', parseNumber],
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
	if (didChangeCenter) beginDeepInteractionMotion();
	if (persist) persistStateToHash();
}

function setPreciseCenterState(centerReal, centerImag, { syncSmoothed = false, persist = true } = {}) {
	const didChangeCenter = state.deepCenterReal !== centerReal || state.deepCenterImag !== centerImag;
	state.deepCenterReal = centerReal;
	state.deepCenterImag = centerImag;
	syncApproximateCenterFromPreciseState({ syncSmoothed });
	if (didChangeCenter) beginDeepInteractionMotion();
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
	if (didChangeZoom) beginDeepInteractionMotion();
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
	paletteFrame = 0;
	lastPaletteUpdateMs = null;
	updateColors(0);
	deepZoomManager.invalidate();
	lastStandardIterationRenderSignature = null;
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
				const key =
					shortKey === 'V' ? 'stripeAverage' : Object.keys(shortKeys).find(k => shortKeys[k] === shortKey);
				if (!key) return null;
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
// Hand the canvas to the profiler (not the GL context — see note in profiler.js).
profiler.setCanvas(canvas);

const colors = new Float32Array(N_COLORS * 3);

// Pack the current palette into a 1D texture of sRGB-encoded bytes. The
// SRGB8_ALPHA8 internal format on the GPU side decodes each entry to linear
// on sample, so LINEAR filtering blends in linear space (gamma-correct).
function buildPaletteTextureSource() {
	const data = new Uint8Array(N_COLORS * 4);
	for (let i = 0; i < N_COLORS; i++) {
		const src = i * 3;
		const dst = i * 4;
		data[dst] = Math.round(colors[src] * 255);
		data[dst + 1] = Math.round(colors[src + 1] * 255);
		data[dst + 2] = Math.round(colors[src + 2] * 255);
		data[dst + 3] = 255;
	}
	return { data, width: N_COLORS, height: 1 };
}

// sRGB → linear (IEC 61966-2-1). Matches the GPU's SRGB8_ALPHA8 decode, so
// the inside color mixes correctly against the palette in linear space.
function srgbToLinear(c) {
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Inside color (used when metric.w is low): 50/50 mix of palette[0] and
// palette[1] in linear space at 18% brightness. Uploaded as a linear-space
// uniform so the display shader can mix it directly with the linear palette
// sample.
function getInsideColor() {
	const INSIDE_BRIGHTNESS = 0.18;
	const r = (srgbToLinear(colors[0]) + srgbToLinear(colors[3])) * 0.5;
	const g = (srgbToLinear(colors[1]) + srgbToLinear(colors[4])) * 0.5;
	const b = (srgbToLinear(colors[2]) + srgbToLinear(colors[5])) * 0.5;
	return [r * INSIDE_BRIGHTNESS, g * INSIDE_BRIGHTNESS, b * INSIDE_BRIGHTNESS];
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

function getShaderPadOptions(options = {}) {
	return {
		canvas,
		...options,
	};
}

function advancePaletteFrame(nowMs) {
	if (lastPaletteUpdateMs !== null && state.isPlaying) {
		const effectiveSpeed = state.speed * state.speed;
		paletteFrame +=
			((nowMs - lastPaletteUpdateMs) / 1000 / PALETTE_SECONDS_PER_BAND) *
			state.animationDirection *
			effectiveSpeed;
		// Wrap so paletteFrame stays bounded. Unbounded growth loses float32 precision
		// against u_colorScale * smoothIters and the palette can stop visibly advancing.
		paletteFrame -= Math.floor(paletteFrame / N_COLORS) * N_COLORS;
	}
	lastPaletteUpdateMs = nowMs;
}

function getCanvasDisplaySize() {
	const rect = canvas.getBoundingClientRect();
	return {
		width: rect.width || canvas.clientWidth || window.innerWidth,
		height: rect.height || canvas.clientHeight || window.innerHeight,
	};
}

function syncCanvasResolution() {
	const displaySize = getCanvasDisplaySize();
	// Drop resolution during deep-zoom motion only — the perturbation shader is
	// the bottleneck there. Standard mode is GPU-cheap (especially with the
	// chained iteration/display split below) and doesn't need the trade.
	const shouldDropForMotion = isDeepInteractionInMotion && isDeepZoomRequested(smoothedZoom[0]);
	const effectiveMultiplier = shouldDropForMotion
		? Math.max(MIN_RESOLUTION_MULTIPLIER, Math.min(resolutionMultiplier, INTERACTION_MOTION_RESOLUTION_MULTIPLIER))
		: resolutionMultiplier;
	const width = Math.max(1, Math.round(displaySize.width * effectiveMultiplier));
	const height = Math.max(1, Math.round(displaySize.height * effectiveMultiplier));
	if (canvas.width === width && canvas.height === height) return;

	canvas.width = width;
	canvas.height = height;

	// shaderpad's MutationObserver-based texture resize fires after the current
	// task, leaving u_liveMetrics bound to a deleted texture and the canvas black
	// until the next signature change. Sync now and rebind the sampler.
	standardIterationRenderer?.syncRes();
	deepIterationRenderer?.syncRes();
	displayRenderer?.syncRes();
	// Force the next frame to re-run the iteration pass so the display sampler
	// rebinds against the freshly recreated metric FBO.
	lastStandardIterationRenderSignature = null;
	lastDeepIterationRenderSignature = null;
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

function updateDeepInteractionMotion() {
	if (Math.abs(smoothedZoom[0] - lastObservedZoom) <= 1e-9) return;
	lastObservedZoom = smoothedZoom[0];
	beginDeepInteractionMotion();
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

function getSlopeLightDirection(angleDegrees) {
	const angleRadians = (angleDegrees * Math.PI) / 180;
	return [Math.cos(angleRadians), Math.sin(angleRadians)];
}

function updateSlopeLightAngle(delta) {
	const slopeLightAngle = (state.slopeLightAngle + delta + 360) % 360;
	setState({ slopeLightAngle });
	showInfo(`Light direction: ${Math.round(slopeLightAngle)}deg`);
}

function updateSlopeLightHeight(delta) {
	const slopeLightHeight = Math.max(
		MIN_SLOPE_LIGHT_HEIGHT,
		Math.min(MAX_SLOPE_LIGHT_HEIGHT, state.slopeLightHeight + delta),
	);
	setState({ slopeLightHeight });
	showInfo(`Light height: ${slopeLightHeight.toFixed(1)}`);
}

function updateSlopeLightIntensity(delta) {
	const slopeLightIntensity = Math.max(
		MIN_SLOPE_LIGHT_INTENSITY,
		Math.min(MAX_SLOPE_LIGHT_INTENSITY, state.slopeLightIntensity + delta),
	);
	setState({ slopeLightIntensity });
	showInfo(`Light intensity: ${slopeLightIntensity.toFixed(2)}`);
}

function initializeStandardIterationUniforms(renderState) {
	standardIterationRenderer.initializeUniform('u_center', 'float', [renderState.xPosition, renderState.yPosition]);
	standardIterationRenderer.initializeUniform('u_zoom', 'float', renderState.zoomScale);
	standardIterationRenderer.initializeUniform('u_fractalType', 'int', renderState.fractalType);
	standardIterationRenderer.initializeUniform('u_exponent', 'int', renderState.exponent);
	standardIterationRenderer.initializeUniform('u_cReal', 'float', renderState.cReal);
	standardIterationRenderer.initializeUniform('u_cImaginary', 'float', renderState.cImaginary);
	standardIterationRenderer.initializeUniform('u_escapeRadius', 'float', renderState.escapeRadius);
	standardIterationRenderer.initializeUniform('u_logEscapeRadius', 'float', renderState.logEscapeRadius);
	standardIterationRenderer.initializeUniform('u_iterations', 'int', renderState.iterations);
	standardIterationRenderer.initializeUniform('u_stripeAverage', 'int', renderState.stripeAverage);
}

function ensureStandardIterationRenderer(renderState) {
	if (standardIterationRenderer) return;
	standardIterationRenderer = new ShaderPad(fragmentSource, {
		...getShaderPadOptions(),
		...METRIC_TEXTURE_OPTIONS,
	});
	initializeStandardIterationUniforms(renderState);
}

function updateStandardIterationUniforms(renderState) {
	standardIterationRenderer.updateUniforms({
		u_center: [renderState.xPosition, renderState.yPosition],
		u_zoom: renderState.zoomScale,
		u_fractalType: renderState.fractalType,
		u_exponent: renderState.exponent,
		u_cReal: renderState.cReal,
		u_cImaginary: renderState.cImaginary,
		u_escapeRadius: renderState.escapeRadius,
		u_logEscapeRadius: renderState.logEscapeRadius,
		u_iterations: renderState.iterations,
		u_stripeAverage: renderState.stripeAverage,
	});
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
	const referenceOffset = deepZoomManager.getReferenceOffsetFor(renderState);
	return {
		u_orbitLength: deepZoomManager.getReferenceOrbitLength(),
		u_radiusMantissa: mantissa,
		u_radiusExponent: exponent,
		u_referenceOffset: [referenceOffset?.offsetReal ?? 0, referenceOffset?.offsetImag ?? 0],
	};
}

function canRenderFromCurrentDeepReference(renderState) {
	if (!deepZoomManager.hasRenderableReferenceFor(renderState)) return false;
	const referenceOffset = deepZoomManager.getReferenceOffsetFor(renderState);
	if (!referenceOffset) return false;
	const maxOffset = Math.max(Math.abs(referenceOffset.offsetReal), Math.abs(referenceOffset.offsetImag));
	return Number.isFinite(maxOffset) && maxOffset <= DEEP_COMPATIBLE_REFERENCE_MAX_OFFSET;
}

function shouldRecenterDeepReference(renderState) {
	if (!canRenderFromCurrentDeepReference(renderState)) return true;
	// Keep this explicit for preparation calls that pass a headroom-sized target
	// state: even if the current frame can draw, the next reference may need a
	// larger budget than the existing one.
	if (deepZoomManager.referenceIterationsBelow(renderState)) return true;
	if (deepZoomManager.hasReferenceFor(renderState)) return false;
	const referenceOffset = deepZoomManager.getReferenceOffsetFor(renderState);
	if (!referenceOffset) return true;
	const maxOffset = Math.max(Math.abs(referenceOffset.offsetReal), Math.abs(referenceOffset.offsetImag));
	const recenterOffset = isDeepInteractionInMotion
		? DEEP_REFERENCE_RECENTER_OFFSET
		: DEEP_SETTLED_REFERENCE_RECENTER_OFFSET;
	return !Number.isFinite(maxOffset) || maxOffset > recenterOffset;
}

function getStandardIterationBudget(zoom) {
	// Constant within the standard zoom range so pixels don't suddenly escape as the
	// user zooms in. For fractals deep mode doesn't support, grow with zoom past the
	// deep threshold (deep mode never kicks in for those).
	if (zoom <= DEEP_ZOOM_THRESHOLD) return BASE_ITERATIONS;
	const target = Math.ceil(BASE_ITERATIONS + (zoom - DEEP_ZOOM_THRESHOLD) * DEEP_ITERATION_ZOOM_FACTOR);
	return Math.min(DEEP_MAX_ITERATIONS, target);
}

function getDeepIterationBudget(zoom) {
	// Continuous so per-frame iter growth shows as 0-1 newly-escaping pixels at most,
	// not as a 256-step jump that fills a band of pixels at once. The reference orbit
	// is sized with DEEP_REFERENCE_ITERATION_HEADROOM_EXPONENT extra zoom units worth
	// of iterations on top of this, so orbit recomputes don't fire as u_iterations
	// ticks up — only when the user pans or radically shifts zoom.
	const target = Math.ceil(
		DEEP_MIN_ITERATIONS + Math.max(0, zoom - DEEP_ZOOM_THRESHOLD) * DEEP_ITERATION_ZOOM_FACTOR,
	);
	return Math.min(DEEP_MAX_ITERATIONS, Math.max(DEEP_MIN_ITERATIONS, target));
}

function initializeDeepIterationUniforms(renderState) {
	const deepUniforms = getDeepShaderUniforms(renderState);
	deepIterationRenderer.initializeUniform('u_iterations', 'int', renderState.deepIterations);
	deepIterationRenderer.initializeUniform('u_orbitLength', 'int', deepUniforms.u_orbitLength);
	deepIterationRenderer.initializeUniform('u_fractalType', 'int', renderState.fractalType);
	deepIterationRenderer.initializeUniform('u_radiusMantissa', 'float', deepUniforms.u_radiusMantissa);
	deepIterationRenderer.initializeUniform('u_radiusExponent', 'int', deepUniforms.u_radiusExponent);
	deepIterationRenderer.initializeUniform('u_referenceOffset', 'float', deepUniforms.u_referenceOffset);
	deepIterationRenderer.initializeUniform('u_escapeRadius', 'float', renderState.escapeRadius);
	deepIterationRenderer.initializeUniform('u_logEscapeRadius', 'float', renderState.logEscapeRadius);
	deepIterationRenderer.initializeUniform('u_stripeAverage', 'int', renderState.stripeAverage);
}

function updateDeepIterationUniforms(renderState) {
	const deepUniforms = getDeepShaderUniforms(renderState);
	deepIterationRenderer.updateUniforms({
		u_iterations: renderState.deepIterations,
		u_orbitLength: deepUniforms.u_orbitLength,
		u_fractalType: renderState.fractalType,
		u_radiusMantissa: deepUniforms.u_radiusMantissa,
		u_radiusExponent: deepUniforms.u_radiusExponent,
		u_referenceOffset: deepUniforms.u_referenceOffset,
		u_escapeRadius: renderState.escapeRadius,
		u_logEscapeRadius: renderState.logEscapeRadius,
		u_stripeAverage: renderState.stripeAverage,
	});
}

function syncDeepOrbitTexture() {
	if (!deepIterationRenderer) return;

	const orbitTextureSource = deepZoomManager.getOrbitTextureSource();
	const blaTextureSource = deepZoomManager.getBLATextureSource();
	const visualPrefixTextureSource = deepZoomManager.getVisualPrefixTextureSource();
	if (!orbitTextureSource || !blaTextureSource || !visualPrefixTextureSource) return;

	if (lastUploadedDeepOrbitSignature === deepZoomManager.referenceSignature) return;

	profiler.measure('deep:uploadOrbit', () => {
		if (lastUploadedDeepOrbitSignature === null) {
			deepIterationRenderer.initializeTexture('u_orbitTexture', orbitTextureSource, ORBIT_TEXTURE_OPTIONS);
			// BLA table uses the same RGBA32F NEAREST options as the orbit texture —
			// both are sampled by index, not interpolated.
			deepIterationRenderer.initializeTexture('u_blaTable', blaTextureSource, ORBIT_TEXTURE_OPTIONS);
			deepIterationRenderer.initializeTexture(
				'u_visualPrefixTexture',
				visualPrefixTextureSource,
				ORBIT_TEXTURE_OPTIONS,
			);
		} else {
			deepIterationRenderer.updateTextures({
				u_orbitTexture: orbitTextureSource,
				u_blaTable: blaTextureSource,
				u_visualPrefixTexture: visualPrefixTextureSource,
			});
		}
	});

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

function ensureDisplayRenderer(renderState, iterationRenderer) {
	if (displayRenderer) return;
	displayRenderer = new ShaderPad(generateDeepDisplayShader(), getShaderPadOptions());
	displayRenderer.initializeUniform('u_insideColor', 'float', getInsideColor());
	displayRenderer.initializeUniform('u_paletteFrame', 'float', renderState.paletteFrame);
	displayRenderer.initializeUniform('u_colorScale', 'float', renderState.colorScale);
	displayRenderer.initializeUniform('u_slopeShading', 'int', renderState.slopeShading);
	displayRenderer.initializeUniform('u_slopeLightDir', 'float', renderState.slopeLightDir);
	displayRenderer.initializeUniform('u_slopeLightHeight', 'float', renderState.slopeLightHeight);
	displayRenderer.initializeUniform('u_slopeLightIntensity', 'float', renderState.slopeLightIntensity);
	displayRenderer.initializeTexture('u_palette', buildPaletteTextureSource(), PALETTE_TEXTURE_OPTIONS);
	displayRenderer.initializeTexture('u_liveMetrics', iterationRenderer);
	displayRendererColorsVersion = colorsVersion;
}

function updateDisplayUniforms(renderState) {
	displayRenderer.updateUniforms({
		u_paletteFrame: renderState.paletteFrame,
		u_colorScale: renderState.colorScale,
		u_slopeShading: renderState.slopeShading,
		u_slopeLightDir: renderState.slopeLightDir,
		u_slopeLightHeight: renderState.slopeLightHeight,
		u_slopeLightIntensity: renderState.slopeLightIntensity,
	});

	if (displayRendererColorsVersion !== colorsVersion) {
		displayRenderer.updateTextures({ u_palette: buildPaletteTextureSource() });
		displayRenderer.updateUniforms({ u_insideColor: getInsideColor() });
		displayRendererColorsVersion = colorsVersion;
	}
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

function getRenderState() {
	const zoomScale = getApproximateZoomScale(smoothedZoom[0]);
	const centerRealExact = state.deepCenterReal;
	const centerImagExact = state.deepCenterImag;
	const radiusExact = getCurrentRadiusExact();
	const approximateCenterReal = Number(centerRealExact);
	const approximateCenterImag = Number(centerImagExact);
	const approximateRadius = Number(radiusExact);
	const fallbackRadius = Math.pow(2, 1 - smoothedZoom[0]);
	const standardIterations = getStandardIterationBudget(smoothedZoom[0]);
	const deepIterations = getDeepIterationBudget(smoothedZoom[0]);
	const slopeLightAngle = Number.isFinite(state.slopeLightAngle)
		? state.slopeLightAngle
		: defaultState.slopeLightAngle;
	const slopeLightHeight = Math.max(MIN_SLOPE_LIGHT_HEIGHT, Math.min(MAX_SLOPE_LIGHT_HEIGHT, state.slopeLightHeight));
	const slopeLightIntensity = Math.max(
		MIN_SLOPE_LIGHT_INTENSITY,
		Math.min(MAX_SLOPE_LIGHT_INTENSITY, state.slopeLightIntensity),
	);
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
		paletteFrame,
		fractalType: state.fractalType,
		exponent: state.exponent,
		cReal: state.cReal,
		cImaginary: state.cImaginary,
		iterations: standardIterations,
		deepIterations,
		escapeRadius: state.escapeRadius,
		logEscapeRadius: Math.log(state.escapeRadius),
		colorScale: Math.max(MIN_COLOR_SCALE, Math.min(MAX_COLOR_SCALE, state.colorScale)),
		slopeShading: state.slopeShading,
		slopeLightDir: getSlopeLightDirection(slopeLightAngle),
		slopeLightHeight,
		slopeLightIntensity,
		stripeAverage: state.stripeAverage,
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
	if (SHOW_ZOOM_MODE_NOTICES) {
		if (isDeepActive) {
			showInfo('Deep zoom');
		} else if (lastDeepZoomActive) {
			showInfo('Standard zoom');
		}
	}
	lastDeepZoomActive = isDeepActive;
}

function shouldPrepareDeepZoom(zoom) {
	return zoom > DEEP_ZOOM_THRESHOLD - DEEP_ZOOM_PREPARATION_MARGIN_EXPONENT;
}

function getReferenceIterationCount(zoom, currentDeepIterations) {
	// Round up to a coarse quantum so the trigger comparison in referenceIterationsBelow
	// (stored < target) doesn't fire every zoom unit. With u_iterations continuous and
	// the per-zoom-unit target growing by DEEP_ITERATION_ZOOM_FACTOR, a fine-grained
	// target would force a recompute every frame of zooming, and each recompute is a
	// visible jump (findGoodReferenceCenter may shift the center, u_referenceOffset
	// changes, every pixel sees a different reference). The quantum here amortizes
	// each (expensive) GMP compute across many zoom units of zooming.
	const headroomZoom = Math.max(zoom, DEEP_ZOOM_THRESHOLD) + DEEP_REFERENCE_ITERATION_HEADROOM_EXPONENT;
	const target = getDeepIterationBudget(headroomZoom);
	const quantized = Math.ceil(target / DEEP_REFERENCE_ITERATION_QUANTUM) * DEEP_REFERENCE_ITERATION_QUANTUM;
	return Math.max(currentDeepIterations, quantized);
}

function ensureDeepZoomPreparation(renderState, requested, support) {
	const shouldPrepare = requested || shouldPrepareDeepZoom(renderState.zoom);
	if (!shouldPrepare) return;
	if (!deepZoomManager.isInitialized) {
		initializeDeepZoom();
		return;
	}
	if (!support.supported) return;

	const referenceIterations = getReferenceIterationCount(renderState.zoom, renderState.deepIterations);
	const referenceTargetState = {
		...renderState,
		// findGoodReferenceCenter accepts samples whose orbit covers requiredIterations
		// (= what the shader actually runs), then recomputes at deepIterations for headroom.
		requiredIterations: renderState.deepIterations,
		deepIterations: referenceIterations,
	};

	if (deepZoomManager.hasPendingReferenceFor(referenceTargetState)) return;
	// Replacing in-flight references during continuous zoom can starve the first
	// deep render, but only keep an older pending request when the current
	// reference is still safe to draw. If fast zoom has already outgrown it,
	// supersede the pending request with one that covers the current budget.
	if (deepZoomManager.pendingReferencePromise && canRenderFromCurrentDeepReference(renderState)) return;

	if (!shouldRecenterDeepReference(referenceTargetState)) return;

	// Defer recompute while the user is actively interacting, as long as the existing
	// reference is still usable. Otherwise the recompute completes mid-motion and the
	// reference swap is visible as a flash; deferring batches multiple swap triggers
	// into a single jump at rest. If the existing reference is unusable (no reference,
	// or offset past MAX), recompute immediately — rendering would otherwise break.
	if (isDeepInteractionInMotion && canRenderFromCurrentDeepReference(renderState)) return;

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
		renderState.escapeRadius.toPrecision(12),
		renderState.logEscapeRadius.toPrecision(12),
		renderState.fractalType,
		renderState.exponent,
		renderState.cReal.toPrecision(12),
		renderState.cImaginary.toPrecision(12),
		renderState.stripeAverage,
		canvas.width,
		canvas.height,
	].join('|');
}

function getStandardIterationRenderSignature(renderState) {
	return [
		renderState.xPosition,
		renderState.yPosition,
		renderState.zoomScale,
		renderState.iterations,
		renderState.fractalType,
		renderState.exponent,
		renderState.cReal.toPrecision(12),
		renderState.cImaginary.toPrecision(12),
		renderState.escapeRadius.toPrecision(12),
		renderState.logEscapeRadius.toPrecision(12),
		renderState.stripeAverage,
		canvas.width,
		canvas.height,
	].join('|');
}

function render(time) {
	profiler.measure('frame:advancePalette', () => advancePaletteFrame(time));
	profiler.measure('frame:tweens+motion', () => {
		zoomTween.update(time);
		updateDeepInteractionMotion();
	});
	profiler.measure('frame:syncCanvas', () => syncCanvasResolution());

	if (isPreciseNavigationActive(smoothedZoom[0])) {
		positionTween.stop();
		smoothedPosition[0] = state.xPosition;
		smoothedPosition[1] = state.yPosition;
	} else {
		positionTween.update(time);
	}

	const renderState = profiler.measure('frame:getRenderState', () => getRenderState());
	const requestedDeepZoom = isDeepZoomRequested(renderState.zoom);
	const deepZoomSupport = deepZoomManager.supportsState(state);
	profiler.measure('frame:ensureDeepPrep', () =>
		ensureDeepZoomPreparation(renderState, requestedDeepZoom, deepZoomSupport),
	);
	maybeShowUnsupportedDeepZoomNotice(requestedDeepZoom, deepZoomSupport);

	const canRenderDeep =
		requestedDeepZoom && deepZoomSupport.supported && canRenderFromCurrentDeepReference(renderState);
	const deepHasCachedFrame =
		requestedDeepZoom && deepZoomSupport.supported && deepIterationRenderer && lastDeepIterationRenderSignature;

	// Iteration pass: run only when something iteration-affecting changed.
	//   1. Deep reference exists → step deep iteration. Short-orbit references
	//      still produce useful output via the in-shader iteration-extension
	//      rebase (k >= orbitLength-1 fold), so we don't reject by orbit length.
	//   2. Deep zoom requested but reference missing / not yet computed → hold
	//      the last good deep FBO if available, else fall through to standard.
	//   3. Otherwise → standard renderer.
	let iterationRenderer;
	if (canRenderDeep) {
		ensureDeepIterationRenderer(renderState);
		const signature = getDeepIterationRenderSignature(renderState);
		if (lastDeepIterationRenderSignature !== signature) {
			profiler.measure('deep:updateUniforms', () => updateDeepIterationUniforms(renderState));
			profiler.measure('deep:syncOrbit', () => syncDeepOrbitTexture());
			profiler.measureGL('deep:iterStep (GPU)', () => deepIterationRenderer.step());
			lastDeepIterationRenderSignature = signature;
			profiler.note('deep:u_iterations', renderState.deepIterations);
		}
		iterationRenderer = deepIterationRenderer;
	} else if (deepHasCachedFrame) {
		iterationRenderer = deepIterationRenderer;
		profiler.note('deep:holdFrame', 1);
	} else {
		ensureStandardIterationRenderer(renderState);
		const signature = getStandardIterationRenderSignature(renderState);
		if (lastStandardIterationRenderSignature !== signature) {
			profiler.measure('std:updateUniforms', () => updateStandardIterationUniforms(renderState));
			profiler.measureGL('std:iterStep (GPU)', () => standardIterationRenderer.step());
			lastStandardIterationRenderSignature = signature;
			profiler.note('std:u_iterations', renderState.iterations);
		}
		iterationRenderer = standardIterationRenderer;
	}

	ensureDisplayRenderer(renderState, iterationRenderer);
	profiler.measure('display:updateTextures', () =>
		displayRenderer.updateTextures({ u_liveMetrics: iterationRenderer }),
	);
	profiler.measure('display:updateUniforms', () => updateDisplayUniforms(renderState));
	profiler.measureGL('display:draw (GPU)', () => displayRenderer.draw());

	maybeShowDeepZoomModeNotice(requestedDeepZoom, deepZoomSupport);
	profiler.tick(time);
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
