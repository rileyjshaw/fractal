import { tinykeys } from 'tinykeys';
import * as profiler from '../profiler.js';
import {
	MIN_EXPONENT,
	MAX_EXPONENT,
	MAX_CONSTANT_COMPONENT,
	MIN_ESCAPE_RADIUS,
	MAX_ESCAPE_RADIUS,
	MIN_COLOR_SCALE,
	MAX_COLOR_SCALE,
	SLOPE_LIGHT_ANGLE_STEP,
	SLOPE_LIGHT_HEIGHT_STEP,
	SLOPE_LIGHT_INTENSITY_STEP,
	MIN_SPEED,
	MAX_SPEED,
	FRACTAL_TYPES,
	MIN_ZOOM_EXPONENT,
	MAX_ZOOM_EXPONENT,
} from '../config.js';

export function bindKeyboardControls({
	state,
	updateColors,
	setResolutionMultiplier,
	getResolutionMultiplier,
	showInfo,
	setState,
	updateSlopeLightIntensity,
	updateSlopeLightHeight,
	updateSlopeLightAngle,
	zoomTween,
	positionTween,
	setPreciseCenterState,
	setZoomState,
	isPreciseNavigationActive,
	resetState,
	translateViewCenter,
	exportFrame,
}) {
	const instructionsContainer = document.getElementById('instructions');
	return tinykeys(window, {
		KeyC: () => updateColors(1),
		'Shift+KeyC': () => updateColors(-1),
		KeyD: () => {
			setResolutionMultiplier(getResolutionMultiplier() * 2);
			showInfo(`Density: ${getResolutionMultiplier() * 100}%`);
		},
		'Shift+KeyD': () => {
			setResolutionMultiplier(getResolutionMultiplier() / 2);
			showInfo(`Density: ${getResolutionMultiplier() * 100}%`);
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
			exportFrame();
		},
		Escape: () => {
			instructionsContainer.classList.remove('show');
		},
	});
}
