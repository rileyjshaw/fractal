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

import palettes from './palettes';
import { hexToNormalizedRGB } from './util';

// Shaders.
import vertexSource from './vertex.vert';
import fragmentSource from './julia.frag';

import './style.css';

const N_COLORS = 8;
const MAX_ZOOM = 100000;

tinykeys(window, {
	// Change colors.
	KeyC: () => updateColors(),
	'Shift+KeyC': () => updateColors(-1),
	// Increase / decrease resolution density.
	KeyD: () => {
		resolutionMultiplier = Math.min(2, resolutionMultiplier * 2);
		showInfo(`Density: ${resolutionMultiplier * 100}%`);
	},
	'Shift+KeyD': () => {
		resolutionMultiplier /= 2;
		showInfo(`Density: ${resolutionMultiplier * 100}%`);
	},
	// Increase / decrease set exponent.
	KeyE: () => {
		exponent = Math.min(16, exponent + 1);
		showInfo(`Exponent: ${exponent}`);
	},
	'Shift+KeyE': () => {
		exponent = Math.max(2, exponent - 1);
		showInfo(`Exponent: ${exponent}`);
	},
	// Increase / decrease imaginary component.
	KeyI: () => {
		cImaginary = Math.min(3, cImaginary + 0.1);
		showInfo(`C (imaginary): ${cImaginary.toFixed(1)}`);
	},
	'Shift+KeyI': () => {
		cImaginary = Math.max(-3, cImaginary - 0.1);
		showInfo(`C (imaginary): ${cImaginary.toFixed(1)}`);
	},
	// Increase / decrease real component.
	KeyR: () => {
		cReal = Math.min(3, cReal + 0.1);
		showInfo(`C (real): ${cReal.toFixed(1)}`);
	},
	'Shift+KeyR': () => {
		cReal = Math.max(-3, cReal - 0.1);
		showInfo(`C (real): ${cReal.toFixed(1)}`);
	},
	// Maximum zoom in / out.
	KeyZ: () => {
		zoomTween.stop();
		zoom[0] = MAX_ZOOM;
		zoomTween.easing(Easing.Quintic.In).startFromCurrentValues();
	},
	'Shift+KeyZ': () => {
		zoomTween.stop();
		zoom[0] = 1;
		zoomTween.easing(Easing.Quintic.Out).startFromCurrentValues();
	},
	// Pause / play.
	Space: () => {
		isPaused = !isPaused;
		showInfo(isPaused ? 'Paused' : 'Playing');
	},
	'Shift+Space': () => {
		animationDirection *= -1;
	},
	'Shift+?': () => {
		instructionsContainer.classList.toggle('show');
	},
	Escape: () => {
		instructionsContainer.classList.remove('show');
	},
});

let exponent = 2;
let cReal = -0.7;
let cImaginary = -0.5;
let isPaused = true;
let animationDirection = 1;

const instructionsContainer = document.getElementById('instructions');
instructionsContainer.querySelector('button').addEventListener('click', () => {
	instructionsContainer.classList.remove('show');
});

let hideErrorTimeout;
const errorContainer = document.getElementById('error');
function showError() {
	clearTimeout(hideErrorTimeout);
	errorContainer.classList.add('show');
	hideErrorTimeout = window.setTimeout(() => {
		errorContainer.classList.remove('show');
	}, 2000);
}

let hideInfoTimeout;
const infoContainer = document.getElementById('info');
function showInfo(text) {
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

const smoothedZoom = [1];
const zoom = [...smoothedZoom];
const smoothedCenterPosition = [0, 0];
const centerPosition = [...smoothedCenterPosition];
canvas.addEventListener('click', e => {
	const { left, top, width, height } = canvas.getBoundingClientRect();
	const x = e.clientX - left;
	const y = e.clientY - top;
	const normalizedX = (x / width) * 2 - 1;
	const normalizedY = -((y / height) * 2 - 1); // Flip y to match WebGL orientation.
	centerTween.stop();
	centerPosition[0] = smoothedCenterPosition[0] + normalizedX / smoothedZoom[0];
	centerPosition[1] = smoothedCenterPosition[1] + normalizedY / smoothedZoom[0];
	centerTween.startFromCurrentValues();
});
canvas.addEventListener('wheel', e => {
	const factor = 1 + Math.sign(e.deltaY) * 0.05;
	zoomTween.stop();
	zoom[0] = smoothedZoom[0] = Math.max(1, Math.min(MAX_ZOOM, smoothedZoom[0] * factor));
});
// Add pinch to zoom on mobile.
let initialDistance = null;
function getDistance(touches) {
	const dx = touches[0].pageX - touches[1].pageX;
	const dy = touches[0].pageY - touches[1].pageY;
	return Math.sqrt(dx * dx + dy * dy);
}
canvas.addEventListener(
	'touchstart',
	e => {
		if (e.touches.length === 2) {
			e.preventDefault();
			initialDistance = getDistance(e.touches);
		}
	},
	{ passive: false },
);
canvas.addEventListener(
	'touchmove',
	e => {
		if (e.touches.length === 2) {
			e.preventDefault();
			const distance = getDistance(e.touches);
			const factor = distance / initialDistance;
			zoomTween.stop();
			zoom[0] = smoothedZoom[0] = Math.max(1, Math.min(MAX_ZOOM, smoothedZoom[0] * factor));
			initialDistance = distance;
		}
	},
	{ passive: false },
);
canvas.addEventListener('touchend', e => {
	initialDistance = null;
});
const centerTween = new Tween(smoothedCenterPosition);
centerTween.dynamic(true).to(centerPosition, 1000).easing(Easing.Quadratic.InOut);
const zoomTween = new Tween(smoothedZoom).dynamic(true).to(zoom, 16000);

const fragmentShaderInfo = createProgramInfo(gl, [vertexSource, fragmentSource]);

let colors = new Float32Array(N_COLORS * 3);
let nextPaletteIdx = 0;
function updateColors(direction = 1) {
	nextPaletteIdx = (palettes.length + nextPaletteIdx + direction) % palettes.length;
	const normalizedPalette = palettes[nextPaletteIdx].map(hexToNormalizedRGB);
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
}
updateColors(0);

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

let resolutionMultiplier = 2;
function resize() {
	if (resizeCanvasToDisplaySize(gl.canvas, resolutionMultiplier)) {
		initBuffer(); // Reinitialize texture on resize.
		gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
	}
}

function render(time) {
	centerTween.update(time);
	zoomTween.update(time);
	resize();
	gl.bindFramebuffer(gl.FRAMEBUFFER, null); // Bind the default framebuffer (the screen).
	gl.useProgram(fragmentShaderInfo.program);
	setBuffersAndAttributes(gl, fragmentShaderInfo, bufferInfo);

	// Pass data to the fragment shader.
	setUniforms(fragmentShaderInfo, {
		u_resolution: [gl.canvas.width, gl.canvas.height],
		u_frame: isPaused ? 0 : colors.length + (((time * animationDirection) / 62.5) % colors.length), // 16 fps.
		u_center: smoothedCenterPosition,
		u_zoom: smoothedZoom[0],
		u_exponent: exponent,
		u_cReal: cReal,
		u_cImaginary: cImaginary,
		u_colors: colors,
	});
	drawBufferInfo(gl, bufferInfo, gl.TRIANGLE_STRIP);
	requestAnimationFrame(render);
}
requestAnimationFrame(render);
