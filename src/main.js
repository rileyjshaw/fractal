import {
	createProgramInfo,
	createBufferInfoFromArrays,
	createTexture,
	drawBufferInfo,
	resizeCanvasToDisplaySize,
	setBuffersAndAttributes,
	setUniforms,
} from 'twgl-base.js';
import { tinykeys } from 'tinykeys';
import { Tween, Easing } from '@tweenjs/tween.js';

import palettes, { paletteIds } from './palettes';
import { hexToNormalizedRGB, identity, parseNumber, throttle, updateHash } from './util';
import handleTouch from './touch';

// Shaders.
import vertexSource from './vertex.vert';
import fragmentSource from './julia.frag';

import './style.css';

const N_COLORS = 32;
const MIN_ZOOM = 1;
const MAX_ZOOM = 98304;
const MIN_EXPONENT = 2;
const MAX_EXPONENT = 16;
const MAX_CONSTANT_COMPONENT = 2.5; // The maximum absolute value of the constant C’s real or imaginary component.
const MIN_RESOLUTION_MULTIPLIER = 0.0625; // 6.25%.
const MAX_RESOLUTION_MULTIPLIER = 2; // 200%.

// Derived.
const MIN_ZOOM_EXPONENT = Math.log(MIN_ZOOM) / Math.log(2);
const MAX_ZOOM_EXPONENT = Math.log(MAX_ZOOM) / Math.log(2);

tinykeys(window, {
	// Change colors.
	KeyC: () => updateColors(),
	'Shift+KeyC': () => updateColors(-1),
	// Increase / decrease resolution density.
	KeyD: () => {
		resolutionMultiplier = Math.min(MAX_RESOLUTION_MULTIPLIER, resolutionMultiplier * 2);
		showInfo(`Density: ${resolutionMultiplier * 100}%`);
	},
	'Shift+KeyD': () => {
		resolutionMultiplier = Math.max(MIN_RESOLUTION_MULTIPLIER, resolutionMultiplier / 2);
		showInfo(`Density: ${resolutionMultiplier * 100}%`);
	},
	// Increase / decrease set exponent.
	KeyE: () => {
		setState({ exponent: Math.min(MAX_EXPONENT, state.exponent + 1) });
		showInfo(`Exponent: ${state.exponent}`);
	},
	'Shift+KeyE': () => {
		setState({ exponent: Math.max(MIN_EXPONENT, state.exponent - 1) });
		showInfo(`Exponent: ${state.exponent}`);
	},
	// Increase / decrease imaginary component.
	KeyI: () => {
		setState({ cImaginary: Math.min(MAX_CONSTANT_COMPONENT, state.cImaginary + 0.01) });
		showInfo(`C (imaginary): ${state.cImaginary.toFixed(2)}`);
	},
	'Shift+KeyI': () => {
		setState({ cImaginary: Math.max(-MAX_CONSTANT_COMPONENT, state.cImaginary - 0.01) });
		showInfo(`C (imaginary): ${state.cImaginary.toFixed(2)}`);
	},
	// Show / hide labels.
	KeyL: () => {
		showLabels = !showLabels;
		if (showLabels) {
			showInfo('Labels on');
		}
	},
	// Reset position to origin.
	KeyO: () => {
		zoomTween.stop();
		positionTween.stop();
		setState({ xPosition: 0, yPosition: 0, zoom: MIN_ZOOM_EXPONENT });
		zoomTween.to([MIN_ZOOM_EXPONENT], 500).startFromCurrentValues();
		positionTween.to([0, 0], 2000).startFromCurrentValues();
	},
	// Increase / decrease real component.
	KeyR: () => {
		setState({ cReal: Math.min(MAX_CONSTANT_COMPONENT, state.cReal + 0.01) });
		showInfo(`C (real): ${state.cReal.toFixed(2)}`);
	},
	'Shift+KeyR': () => {
		setState({ cReal: Math.max(-MAX_CONSTANT_COMPONENT, state.cReal - 0.01) });
		showInfo(`C (real): ${state.cReal.toFixed(2)}`);
	},
	// Maximum zoom in / out.
	KeyZ: () => {
		zoomTween.stop();
		setState({ zoom: MAX_ZOOM_EXPONENT });
		zoomTween.to([MAX_ZOOM_EXPONENT], 20000).startFromCurrentValues();
	},
	'Shift+KeyZ': () => {
		zoomTween.stop();
		setState({ zoom: MIN_ZOOM_EXPONENT });
		zoomTween.to([MIN_ZOOM_EXPONENT], 20000).startFromCurrentValues();
	},
	// Reset state.
	KeyX: resetState,
	// Pan position.
	ArrowUp: () => {
		positionTween.stop();
		setState({ yPosition: smoothedPosition[1] + 0.005 / Math.pow(2, smoothedZoom[0]) });
		smoothedPosition[1] = state.yPosition;
		// HACK(riley): Tween.js has a bug where stop() doesn’t work completely until the end is reached.
		positionTween.to([state.xPosition, state.yPosition], 0).end();
	},
	'Shift+ArrowUp': () => {
		positionTween.stop();
		setState({ yPosition: smoothedPosition[1] + 0.05 / Math.pow(2, smoothedZoom[0]) });
		smoothedPosition[1] = state.yPosition;
		// HACK(riley): Tween.js has a bug where stop() doesn’t work completely until the end is reached.
		positionTween.to([state.xPosition, state.yPosition], 0).end();
	},
	ArrowDown: () => {
		positionTween.stop();
		setState({ yPosition: smoothedPosition[1] - 0.005 / Math.pow(2, smoothedZoom[0]) });
		smoothedPosition[1] = state.yPosition;
		// HACK(riley): Tween.js has a bug where stop() doesn’t work completely until the end is reached.
		positionTween.to([state.xPosition, state.yPosition], 0).end();
	},
	'Shift+ArrowDown': () => {
		positionTween.stop();
		setState({ yPosition: smoothedPosition[1] - 0.05 / Math.pow(2, smoothedZoom[0]) });
		smoothedPosition[1] = state.yPosition;
		// HACK(riley): Tween.js has a bug where stop() doesn’t work completely until the end is reached.
		positionTween.to([state.xPosition, state.yPosition], 0).end();
	},
	ArrowLeft: () => {
		positionTween.stop();
		setState({ xPosition: smoothedPosition[0] - 0.005 / Math.pow(2, smoothedZoom[0]) });
		smoothedPosition[0] = state.xPosition;
		// HACK(riley): Tween.js has a bug where stop() doesn’t work completely until the end is reached.
		positionTween.to([state.xPosition, state.yPosition], 0).end();
	},
	'Shift+ArrowLeft': () => {
		positionTween.stop();
		setState({ xPosition: smoothedPosition[0] - 0.05 / Math.pow(2, smoothedZoom[0]) });
		smoothedPosition[0] = state.xPosition;
		// HACK(riley): Tween.js has a bug where stop() doesn’t work completely until the end is reached.
		positionTween.to([state.xPosition, state.yPosition], 0).end();
	},
	ArrowRight: () => {
		positionTween.stop();
		setState({ xPosition: smoothedPosition[0] + 0.005 / Math.pow(2, smoothedZoom[0]) });
		smoothedPosition[0] = state.xPosition;
		// HACK(riley): Tween.js has a bug where stop() doesn’t work completely until the end is reached.
		positionTween.to([state.xPosition, state.yPosition], 0).end();
	},
	'Shift+ArrowRight': () => {
		positionTween.stop();
		setState({ xPosition: smoothedPosition[0] + 0.05 / Math.pow(2, smoothedZoom[0]) });
		smoothedPosition[0] = state.xPosition;
		// HACK(riley): Tween.js has a bug where stop() doesn’t work completely until the end is reached.
		positionTween.to([state.xPosition, state.yPosition], 0).end();
	},
	// Pause / play.
	Space: () => {
		setState({ isPlaying: 1 - state.isPlaying });
		showInfo(state.isPlaying ? 'Playing' : 'Paused');
	},
	'Shift+Space': () => {
		setState({ animationDirection: state.animationDirection * -1 });
	},
	// Show / hide instructions.
	'Shift+?': () => {
		instructionsContainer.classList.toggle('show');
	},
	Escape: () => {
		instructionsContainer.classList.remove('show');
	},
});

const [state, shortKeys, stateParsers] = Object.entries({
	// Format: [default value, short key, parser]
	cReal: [-0.71, 'R', parseNumber],
	cImaginary: [-0.43, 'I', parseNumber],
	paletteId: [paletteIds[0], 'C'],
	exponent: [2, 'E', parseNumber],
	xPosition: [0, 'X', parseNumber],
	yPosition: [0, 'Y', parseNumber],
	zoom: [MIN_ZOOM_EXPONENT, 'Z', parseNumber],
	isPlaying: [1, 'P', parseNumber],
	animationDirection: [1, 'D', parseNumber],
}).reduce(
	([state, shortKeys, stateParsers], [key, [value, shortKey, parser]]) => {
		state[key] = value;
		shortKeys[key] = shortKey;
		stateParsers[key] = parser ?? identity;
		return [state, shortKeys, stateParsers];
	},
	[{}, {}, {}],
);
const defaultState = { ...state };

function resetState() {
	Object.assign(state, defaultState);
	smoothedPosition[0] = state.xPosition;
	smoothedPosition[1] = state.yPosition;
	smoothedZoom[0] = state.zoom;
	paletteIdx = 0;
	updateColors(0);
	updateHash('');
}

function setState(diff) {
	Object.entries(diff).forEach(([key, value]) => {
		if (!(key in state)) {
			showError(`Invalid state key: ${key}`);
			return;
		}
		state[key] = value;
	});
	persistStateToHash();
}

const persistStateToHash = throttle(function persistStateToHash() {
	updateHash(
		Object.entries(state)
			.map(([key, value]) => `${shortKeys[key]}=${encodeURIComponent(value)}`)
			.join('_'),
	);
}, 200);

function updateStateFromHash() {
	const hash = location.hash.substring(1); // Remove the "#".
	try {
		const entries = hash
			.split('_')
			.map(str => {
				if (!str) return null;

				const [shortKey, encodedValue] = str.split('=');
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
				case 'xPosition':
					smoothedPosition[0] = value;
					break;
				case 'yPosition':
					smoothedPosition[1] = value;
					break;
				case 'zoom':
					smoothedZoom[0] = value;
					break;
			}
		});

		return entries.length;
	} catch (e) {
		// Handle parsing error.
		console.error('Error parsing the hash', e);
	}
}

// Some state doesn’t make sense to share, so it’s left out of the hash state.
let resolutionMultiplier = 2;
let showLabels = true;
// Smoothed state values are kept in arrays so tween.js can work with them.
const smoothedZoom = [state.zoom];
const smoothedPosition = [state.xPosition, state.yPosition];
const positionTween = new Tween(smoothedPosition).easing(Easing.Quadratic.InOut);
const zoomTween = new Tween(smoothedZoom).easing(Easing.Quadratic.InOut);

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

const canvas = document.getElementById('canvas');
const gl = canvas.getContext('webgl2', { antialias: false });
gl.imageSmoothingEnabled = false;

const fragmentShaderInfo = createProgramInfo(gl, [vertexSource, fragmentSource]);

let colors = new Float32Array(N_COLORS * 3);
function updateColors(direction = 1) {
	paletteIdx = (paletteIds.length + paletteIdx + direction) % paletteIds.length;
	const paletteId = paletteIds[paletteIdx];
	const palette = palettes[paletteId];
	if (direction) setState({ paletteId: paletteId });

	const normalizedPalette = palette.map(hexToNormalizedRGB);
	for (let i = 0; i < N_COLORS; ++i) {
		const rgbComponents = [...normalizedPalette[i % normalizedPalette.length]];
		if (i >= normalizedPalette.length) {
			// Add a small random offset to the RGB components for variety.
			for (let j = 0; j < rgbComponents.length; ++j) {
				rgbComponents[j] = Math.max(0, Math.min(1, rgbComponents[j] + Math.random() * 0.1 - 0.05));
			}
		}
		const rIdx = i * 3;
		colors[rIdx] = rgbComponents[0];
		colors[rIdx + 1] = rgbComponents[1];
		colors[rIdx + 2] = rgbComponents[2];
	}
	document.documentElement.style.backgroundColor = palette[0];
}

const arrays = {
	position: {
		numComponents: 2,
		data: [
			-1.0,
			-1.0, // Bottom left.
			1.0,
			-1.0, // Bottom right.
			-1.0,
			1.0, // Top left.
			1.0,
			1.0, // Top right.
		],
	},
};
const bufferInfo = createBufferInfoFromArrays(gl, arrays);

function createScreenTexture(gl, width, height) {
	return createTexture(gl, {
		width,
		height,
		type: gl.UNSIGNED_BYTE,
		format: gl.RED_INTEGER,
		internalFormat: gl.R8UI,
		minMag: gl.NEAREST,
		wrap: gl.CLAMP_TO_EDGE,
	});
}

let screenTexture = null;
function initBuffer() {
	if (screenTexture) gl.deleteTexture(screenTexture);
	screenTexture = createScreenTexture(gl, canvas.width, canvas.height);
}

function resize() {
	if (resizeCanvasToDisplaySize(gl.canvas, resolutionMultiplier)) {
		initBuffer(); // Reinitialize texture on resize.
		gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
	}
}

function render(time) {
	positionTween.update(time, false);
	zoomTween.update(time, false);
	resize();
	gl.bindFramebuffer(gl.FRAMEBUFFER, null); // Bind the default framebuffer (the screen).
	gl.useProgram(fragmentShaderInfo.program);
	setBuffersAndAttributes(gl, fragmentShaderInfo, bufferInfo);

	// Pass data to the fragment shader.
	setUniforms(fragmentShaderInfo, {
		u_resolution: [gl.canvas.width, gl.canvas.height],
		u_frame: state.isPlaying ? colors.length + (((time * state.animationDirection) / 62.5) % colors.length) : 0, // 16 fps.
		u_center: smoothedPosition,
		u_zoom: Math.pow(2, smoothedZoom[0]),
		u_exponent: state.exponent,
		u_cReal: state.cReal,
		u_cImaginary: state.cImaginary,
		u_colors: colors,
	});
	drawBufferInfo(gl, bufferInfo, gl.TRIANGLE_STRIP);
	requestAnimationFrame(render);
}

// Event listeners.
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
	let normalizedY = -((clickY / height) * 2 - 1); // Flip y to match WebGL orientation.
	if (aspectRatio > 1.0) {
		// Landscape.
		normalizedX *= aspectRatio;
	} else {
		// Portrait.
		normalizedY /= aspectRatio;
	}
	const xPosition = smoothedPosition[0] + normalizedX / Math.pow(2, smoothedZoom[0]);
	const yPosition = smoothedPosition[1] + normalizedY / Math.pow(2, smoothedZoom[0]);
	positionTween.stop();
	setState({ xPosition, yPosition });
	positionTween.to([state.xPosition, state.yPosition], 1000).startFromCurrentValues();
});
canvas.addEventListener('wheel', e => {
	const delta = Math.sign(e.deltaY) * 0.05;
	zoomTween.stop();
	setState({ zoom: Math.max(MIN_ZOOM_EXPONENT, Math.min(MAX_ZOOM_EXPONENT, smoothedZoom[0] + delta)) });
	smoothedZoom[0] = state.zoom;
	// HACK(riley): Tween.js has a bug where stop() doesn’t work completely until the end is reached.
	zoomTween.to([state.zoom], 0).end();
});

handleTouch(canvas, (direction, delta, additionalFingers) => {
	if (additionalFingers === 0) {
		if (direction === 'x') {
			if (Math.abs(delta) < 32) return { skip: true };
			updateColors(Math.sign(delta));
		} else {
			zoomTween.stop();
			setState({
				zoom: Math.max(MIN_ZOOM_EXPONENT, Math.min(MAX_ZOOM_EXPONENT, smoothedZoom[0] - delta * 0.05)),
			});
			smoothedZoom[0] = state.zoom;
			// HACK(riley): Tween.js has a bug where stop() doesn’t work completely until the end is reached.
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
			if (Math.abs(delta) < 64) return { skip: true };
			setState({ animationDirection: Math.sign(delta) });
		}
	} else if (additionalFingers === 4) {
		if (Math.abs(delta) < 64) return { skip: true };
		resetState();
	}
});

// Start it up.
const nStateUpdates = updateStateFromHash();
let paletteIdx = paletteIds.indexOf(state.paletteId);
updateColors(0);
requestAnimationFrame(render);

const shouldShowInstructions = nStateUpdates < 3;
if (shouldShowInstructions) {
	instructionsContainer.classList.add('show');
} else {
	document.getElementById('show-instructions').classList.add('show');
}
