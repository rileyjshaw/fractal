import handleTouch from '../touch.js';
import {
	MIN_EXPONENT,
	MAX_EXPONENT,
	MAX_CONSTANT_COMPONENT,
	MIN_ESCAPE_RADIUS,
	MAX_ESCAPE_RADIUS,
	MIN_SPEED,
	MAX_SPEED,
	FRACTAL_TYPES,
	MIN_ZOOM_EXPONENT,
	MAX_ZOOM_EXPONENT,
} from '../config.js';
export function bindPointerControls({
	updateStateFromHash,
	canvas,
	state,
	smoothedZoom,
	smoothedPosition,
	zoomTween,
	positionTween,
	isPreciseNavigationActive,
	translatePreciseCenter,
	getCurrentRadiusExact,
	setApproximateCenterState,
	setZoomState,
	updateColors,
	setState,
}) {
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
					cReal: Math.max(
						-MAX_CONSTANT_COMPONENT,
						Math.min(MAX_CONSTANT_COMPONENT, state.cReal + delta * 0.01),
					),
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
				setState({
					exponent: Math.max(MIN_EXPONENT, Math.min(MAX_EXPONENT, state.exponent + Math.sign(delta))),
				});
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

	return instructionsContainer;
}
