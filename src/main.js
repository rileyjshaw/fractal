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

// Shaders.
import vertexSource from './vertex.vert';
import fragmentSource from './mandelbrot.frag';

import './style.css';

tinykeys(window, {
	// Change colors.
	// KeyC: () => updateColors(),
	// 'Shift+KeyC': () => updateColors(-1),
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
		resetView();
		showInfo(`Exponent: ${exponent}`);
	},
	'Shift+KeyE': () => {
		exponent = Math.max(2, exponent - 1);
		resetView();
		showInfo(`Exponent: ${exponent}`);
	},
	// Pause / play.
	Space: () => {
		isPaused = !isPaused;
		showInfo(isPaused ? 'Paused' : 'Playing');
	},
	'Shift+?': () => {
		instructionsContainer.classList.toggle('show');
	},
	Escape: () => {
		instructionsContainer.classList.remove('show');
	},
});

let exponent = 2;

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

let zoom = 1;
const smoothedCenterPosition = [0, 0];
const centerPosition = [...smoothedCenterPosition];
canvas.addEventListener('click', e => {
	const { left, top, width, height } = canvas.getBoundingClientRect();
	const x = e.clientX - left;
	const y = e.clientY - top;
	const normalizedX = (x / width) * 2 - 1;
	const normalizedY = -((y / height) * 2 - 1); // Flip y to match WebGL orientation.
	centerPosition[0] = smoothedCenterPosition[0] + normalizedX / zoom;
	centerPosition[1] = smoothedCenterPosition[1] + normalizedY / zoom;
	centerTween.stop();
	centerTween.startFromCurrentValues();
});
canvas.addEventListener('wheel', e => {
	const factor = 1 + Math.sign(e.deltaY) * 0.05;
	zoom = Math.max(1, Math.min(100000, zoom * factor));
});
function resetView() {
	zoom = 1;
	centerPosition[0] = exponent === 2 ? -0.2 : 0;
	centerPosition[1] = 0;
	centerTween.startFromCurrentValues();
}
const centerTween = new Tween(smoothedCenterPosition);
centerTween.dynamic(true).to(centerPosition, 1000).easing(Easing.Quadratic.InOut);
resetView();

const fragmentShaderInfo = createProgramInfo(gl, [vertexSource, fragmentSource]);

// let colors = new Float32Array(MAX_N_STATES * 3);
// let nextPaletteIdx = Math.floor(Math.random() * palettes.length);
// function updateColors(direction = 1) {
// 	nextPaletteIdx = (palettes.length + nextPaletteIdx + direction) % palettes.length;
// 	const normalizedPalette = palettes[nextPaletteIdx].map(hexToNormalizedRGB);
// 	for (let i = 0; i < MAX_N_STATES; ++i) {
// 		const rgbComponents = [...normalizedPalette[i % normalizedPalette.length]];
// 		if (i >= normalizedPalette.length) {
// 			// Add a small random offset to the RGB components for variety.
// 			for (let j = 0; j < rgbComponents.length; ++j) {
// 				rgbComponents[j] = Math.max(0, Math.min(1, rgbComponents[j] + Math.random() * 0.1 - 0.05));
// 			}
// 		}
// 		const rIdx = i * 3;
// 		colors[rIdx] = rgbComponents[0];
// 		colors[rIdx + 1] = rgbComponents[1];
// 		colors[rIdx + 2] = rgbComponents[2];
// 	}
// }
// updateColors(0);

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

let isPaused = false;
function render(time) {
	centerTween.update(time);
	time /= 1000; // Convert time to seconds.
	resize();

	gl.bindFramebuffer(gl.FRAMEBUFFER, null); // Bind the default framebuffer (the screen).
	gl.useProgram(fragmentShaderInfo.program);
	setBuffersAndAttributes(gl, fragmentShaderInfo, bufferInfo);

	// Pass data to the fragment shader.
	setUniforms(fragmentShaderInfo, {
		u_resolution: [gl.canvas.width, gl.canvas.height],
		u_center: smoothedCenterPosition,
		u_zoom: zoom,
		u_exponent: exponent,
		// u_colors: colors,
	});
	drawBufferInfo(gl, bufferInfo, gl.TRIANGLE_STRIP);
	requestAnimationFrame(render);
}
requestAnimationFrame(render);
