import { createCameraController } from './state/cameraController.js';
import { RenderResources } from './render/resources.js';
import { chooseFrame, chooseFallback, frameLoop, keepPendingReference, planDeepStep } from './render/coordinator.js';
import { getStandardIterationBudget, getDeepIterationBudget, getReferenceIterationCount } from './render/scheduling.js';
import {
	DEEP_ZOOM_THRESHOLD,
	MIN_RESOLUTION_MULTIPLIER,
	MAX_RESOLUTION_MULTIPLIER,
	MIN_COLOR_SCALE,
	MAX_COLOR_SCALE,
	MIN_SLOPE_LIGHT_HEIGHT,
	MAX_SLOPE_LIGHT_HEIGHT,
	MIN_SLOPE_LIGHT_INTENSITY,
	MAX_SLOPE_LIGHT_INTENSITY,
	DEEP_COMPATIBLE_REFERENCE_MAX_OFFSET,
	DEEP_REFERENCE_RECENTER_OFFSET,
	DEEP_SETTLED_REFERENCE_RECENTER_OFFSET,
	DEEP_ZOOM_PREPARATION_MARGIN_EXPONENT,
	DEEP_INTERACTION_MOTION_SETTLE_MS,
	SHOW_ZOOM_MODE_NOTICES,
	MIN_ZOOM_EXPONENT,
	STANDARD_RENDER_SAFE_ZOOM_EXPONENT,
} from './config.js';
import { createFullscreenCanvas, save } from 'shaderpad/util';
import { bindKeyboardControls } from './ui/controls.js';
import { Tween, Easing } from '@tweenjs/tween.js';

import { paletteNoise } from './render/paletteNoise.js';
import palettes, { paletteIds } from './palettes.js';
import { debounce, hexToNormalizedRGB, identity, parseNumber, srgbToLinear, updateHash } from './util.js';
import { getUrlCenterFractionDigits, serializeStateValueForHash } from './urlHash.js';
import { getApproximateZoomScale } from './viewMath.js';
import { bindPointerControls } from './ui/pointerControls.js';
import { ReferenceService } from './deep/referenceService.js';
import { N_COLORS } from './shaderCommon.js';
import { stateFromHash } from './state/urlState.js';
import { validateStatePatch } from './state/viewState.js';
import { precisionForView } from './math/precision.js';
import { describeFrame, frameCompatible } from './render/frame.js';
import { FLAT_INTERIOR_METRIC, isInvalidMetric } from './render/metric.js';
import * as profiler from './profiler.js';

const PLACEHOLDER_METRIC_SOURCE = { data: new Float32Array(FLAT_INTERIOR_METRIC), width: 1, height: 1 };

export function startApp() {
	const deepZoomManager = new ReferenceService({ threshold: DEEP_ZOOM_THRESHOLD });

	let resolutionMultiplier = window.devicePixelRatio || 1;
	let standardIterationRenderer = null;
	let deepIterationRenderer = null;
	let deepMetricSource = null;
	let deepFrame = null;
	let pendingDeepSignature = null;
	let pendingDeepFrame = null;
	let failedDeepSignature = null;
	let invalidDeepPixels = 0;
	let repairedDeepPixels = 0;
	let displayRenderer = null;
	let lastStandardIterationRenderSignature = null;
	let lastDeepIterationRenderSignature = null;
	let lastUnsupportedDeepZoomReason = null;
	let lastDeepZoomActive = false;
	let isDeepInteractionInMotion = false;
	let deepMetricAnchor = null;
	let deepPreviewTransformCache = null;
	let colorsVersion = 0;
	let paletteFrame = 0;
	let lastPaletteUpdateMs = null;
	const PALETTE_SECONDS_PER_BAND = 0.3125;

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
		// A held frame from before the reset must not be drawn when zooming back in.
		clearDeepFrame();
		pendingDeepSignature = null;
		pendingDeepFrame = null;
		failedDeepSignature = null;
		lastObservedZoom = smoothedZoom[0];
		settleDeepInteractionMotion.clearTimeout();
		setDeepInteractionInMotion(false);
		updateHash('');
	}

	function setState(diff) {
		diff = validateStatePatch(diff, state, paletteIds);
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
		const parsed = stateFromHash(location.hash, state, shortKeys, stateParsers, paletteIds);
		Object.assign(state, parsed.state);
		syncApproximateCenterFromPreciseState({ syncSmoothed: true });
		smoothedZoom[0] = state.zoom;
		paletteIdx = paletteIds.indexOf(state.paletteId);
		updateColors(0);
		return parsed.count;
	}

	let paletteIdx = paletteIds.indexOf(state.paletteId);

	const smoothedZoom = [state.zoom];
	const smoothedPosition = [state.xPosition, state.yPosition];
	const positionTween = new Tween(smoothedPosition).easing(Easing.Quadratic.InOut);
	const zoomTween = new Tween(smoothedZoom).easing(Easing.Quadratic.InOut);
	let lastObservedZoom = smoothedZoom[0];
	const {
		syncApproximateCenterFromPreciseState,
		syncPreciseCenterFromApproximateState,
		getCurrentRadiusExact,
		syncPreciseRadiusFromApproximateZoom,
		setApproximateCenterState,
		setPreciseCenterState,
		isPreciseNavigationActive,
		setZoomState,
		translatePreciseCenter,
		translateViewCenter,
	} = createCameraController({
		state,
		smoothedZoom,
		smoothedPosition,
		deepZoomManager,
		initializeDeepZoom,
		beginDeepInteractionMotion,
		persistStateToHash,
		positionTween,
		isDeepZoomRequested,
	});

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
		clearTimeout(hideInfoTimeout);
		infoContainer.textContent = text;
		infoContainer.classList.add('show');
		hideInfoTimeout = window.setTimeout(() => {
			infoContainer.classList.remove('show');
		}, 2000);
	}

	const canvas = createFullscreenCanvas(document.getElementById('canvas-container'));
	const resources = new RenderResources(canvas);
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
					rgbComponents[j] = Math.max(0, Math.min(1, rgbComponents[j] + paletteNoise(paletteId, i, j)));
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
		const width = Math.max(1, Math.round(displaySize.width * resolutionMultiplier));
		const height = Math.max(1, Math.round(displaySize.height * resolutionMultiplier));
		if (canvas.width === width && canvas.height === height) return;

		canvas.width = width;
		canvas.height = height;

		// shaderpad's MutationObserver-based texture resize fires after the current
		// task, leaving u_liveMetrics bound to a deleted texture and the canvas black
		// until the next signature change. Sync now and rebind the sampler.
		resources.resize(width, height);

		// Force the next frame to re-run the iteration pass so the display sampler
		// rebinds against the freshly recreated metric FBO.
		lastStandardIterationRenderSignature = null;
		clearDeepFrame();
	}

	function clearDeepFrame() {
		deepMetricSource = null;
		deepFrame = null;
		lastDeepIterationRenderSignature = null;
		deepMetricAnchor = null;
		deepPreviewTransformCache = null;
	}

	function setDeepInteractionInMotion(isActive) {
		isDeepInteractionInMotion = isActive;
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

	// Iteration shaders bake fractal type and exponent into the source; recreate on change.
	// Variant-dependent uniforms are compiled out, so uniform calls pass allowMissing.

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
		const slopeLightHeight = Math.max(
			MIN_SLOPE_LIGHT_HEIGHT,
			Math.min(MAX_SLOPE_LIGHT_HEIGHT, state.slopeLightHeight),
		);
		const slopeLightIntensity = Math.max(
			MIN_SLOPE_LIGHT_INTENSITY,
			Math.min(MAX_SLOPE_LIGHT_INTENSITY, state.slopeLightIntensity),
		);
		const renderState = {
			precision: precisionForView(centerRealExact, centerImagExact, radiusExact, canvas.width, canvas.height),
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
		if (shouldKeepPendingReference(renderState)) return;

		if (!shouldRecenterDeepReference(referenceTargetState)) return;

		// Defer recompute while the user is actively interacting, as long as the existing
		// reference is still usable. Otherwise the recompute completes mid-motion and the
		// reference swap is visible as a flash; deferring batches multiple swap triggers
		// into a single jump at rest. If the existing reference is unusable (no reference,
		// or offset past MAX), recompute immediately — rendering would otherwise break.
		if (isDeepInteractionInMotion && canRenderFromCurrentDeepReference(renderState)) return;
		if (deepZoomManager.hasFailedReferenceFor(referenceTargetState)) return;

		deepZoomManager.ensureReference(referenceTargetState).catch(error => {
			showError('Failed to compute deep zoom reference');
			console.error(error);
		});
	}

	function shouldKeepPendingReference(renderState) {
		const pending = deepZoomManager.pendingReferenceState;
		return keepPendingReference({
			moving: isDeepInteractionInMotion,
			pending: pending && {
				formula: deepZoomManager.getReferenceCompatibilitySignature(pending),
				iterations: pending.deepIterations,
			},
			target: {
				formula: deepZoomManager.getReferenceCompatibilitySignature(renderState),
				iterations: renderState.deepIterations,
			},
			reach: pending ? deepZoomManager.getPendingReferenceReach(renderState) : Infinity,
		});
	}

	function setDeepMetricAnchor(renderState) {
		deepMetricAnchor = {
			centerRealExact: renderState.centerRealExact,
			centerImagExact: renderState.centerImagExact,
			radiusExact: renderState.radiusExact,
			key: `${renderState.centerRealExact}|${renderState.centerImagExact}|${renderState.radiusExact}`,
		};
		deepPreviewTransformCache = null;
	}

	function getDeepPreviewTransform(renderState) {
		if (!deepMetricAnchor || !deepZoomManager.isInitialized) return null;
		const cacheKey = [
			deepMetricAnchor.key,
			renderState.centerRealExact,
			renderState.centerImagExact,
			renderState.radiusExact,
		].join('|');
		if (deepPreviewTransformCache?.key === cacheKey) {
			return deepPreviewTransformCache.transform;
		}
		const transform = deepZoomManager.computeViewTransform(
			renderState.centerRealExact,
			renderState.centerImagExact,
			renderState.radiusExact,
			deepMetricAnchor.centerRealExact,
			deepMetricAnchor.centerImagExact,
			deepMetricAnchor.radiusExact,
		);
		deepPreviewTransformCache = { key: cacheKey, transform };
		return transform;
	}

	function getDeepIterationRenderSignature(renderState) {
		// A reference is a way to compute this view, not part of its identity.
		// Finishing a replacement reference must not discard repairs for the same view.
		return [
			renderState.centerRealExact,
			renderState.centerImagExact,
			renderState.radiusExact,
			renderState.deepIterations,
			renderState.escapeRadius.toPrecision(12),
			renderState.logEscapeRadius.toPrecision(12),
			renderState.fractalType,
			renderState.exponent,
			renderState.cReal.toPrecision(12),
			renderState.cImaginary.toPrecision(12),
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
			canvas.width,
			canvas.height,
		].join('|');
	}

	function renderStandard(renderState) {
		standardIterationRenderer = resources.standardPass(renderState);
		const signature = getStandardIterationRenderSignature(renderState);
		if (lastStandardIterationRenderSignature !== signature) {
			profiler.measureGL('std:iterStep (GPU)', () => standardIterationRenderer.step());
			lastStandardIterationRenderSignature = signature;
			profiler.note('std:u_iterations', renderState.iterations);
		}
		return standardIterationRenderer;
	}

	function renderDeepFrame(renderState, signature) {
		profiler.measureGL('deep:iterStep (GPU)', () => deepIterationRenderer.step());
		const metric = resources.readDeepMetrics();
		const frame = describeFrame(renderState, metric.width, metric.height, deepZoomManager.referenceSignature);
		const publish = source => {
			deepMetricSource = source;
			deepFrame = frame;
			lastDeepIterationRenderSignature = signature;
			setDeepMetricAnchor(renderState);
		};
		profiler.note('deep:u_iterations', renderState.deepIterations);
		invalidDeepPixels = 0;
		repairedDeepPixels = 0;
		for (let offset = 0; offset < metric.data.length; offset += 4) {
			if (isInvalidMetric(metric.data, offset)) invalidDeepPixels++;
		}
		if (invalidDeepPixels === 0) {
			// Any pending repair is for an older view than this complete frame.
			deepZoomManager.repairs.cancel();
			pendingDeepSignature = null;
			pendingDeepFrame = null;
			publish(metric);
			return;
		}
		pendingDeepSignature = signature;
		pendingDeepFrame = frame;
		deepZoomManager
			.repairFrame(metric, renderState, progress => {
				if (pendingDeepSignature === signature) repairedDeepPixels = progress.repairedPixels;
			})
			.then(result => {
				// While moving, the view has usually changed by the time a repair finishes.
				// Its frame is still newer than the held one, so it becomes the preview
				// source; the view it no longer matches renders on a later frame.
				const current = getRenderState();
				if (
					getDeepIterationRenderSignature(current) !== signature &&
					!frameCompatible(frame, current, canvas.width, canvas.height)
				)
					return;
				publish(result.metric);
				invalidDeepPixels = 0;
				repairedDeepPixels = result.repairedPixels;
				profiler.note('deep:repairedPixels', result.repairedPixels);
			})
			.catch(error => {
				if (error.name === 'AbortError') return;
				failedDeepSignature = signature;
				showError(error.message);
			})
			.finally(() => {
				if (pendingDeepSignature !== signature) return;
				pendingDeepSignature = null;
				pendingDeepFrame = null;
			});
	}

	function renderFrame(time) {
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
		const { width, height } = canvas;
		const frameChoice = chooseFrame({
			requested: requestedDeepZoom,
			supported: deepZoomSupport.supported,
			referenceReady: canRenderDeep,
			frame: deepFrame,
			state: renderState,
			width,
			height,
			preview: requestedDeepZoom && deepZoomSupport.supported ? getDeepPreviewTransform(renderState) : null,
		});
		// Iteration pass: run only when something iteration-affecting changed.
		//   deep     → a reference can draw this view: iterate it, or keep reprojecting
		//              the held frame while input continues or a repair is pending.
		//   held     → no usable reference yet: reproject the last completed frame.
		//   fallback → deep zoom without any drawable frame (see chooseFallback).
		//   standard → shallow zoom or an unsupported formula.
		let iterationRenderer = null;
		let deepPreviewTransform = null;
		let targetFrame = null;
		let mode = 'deep';
		if (frameChoice === 'deep') {
			deepIterationRenderer = resources.deepPass(renderState, deepZoomManager);
			targetFrame = getDeepIterationRenderSignature(renderState);
			const step = planDeepStep({
				target: targetFrame,
				rendered: lastDeepIterationRenderSignature,
				pending: pendingDeepSignature,
				failed: failedDeepSignature,
				pendingFrame: pendingDeepFrame,
				moving: isDeepInteractionInMotion,
				frame: deepFrame,
				state: renderState,
				width,
				height,
				preview: getDeepPreviewTransform(renderState),
			});
			if (step === 'render') renderDeepFrame(renderState, targetFrame);
			else if (step === 'defer') profiler.note('deep:previewScale', getDeepPreviewTransform(renderState)?.scale);
		} else if (frameChoice === 'held') {
			profiler.note('deep:holdFrame', 1);
		} else if (frameChoice === 'standard') {
			iterationRenderer = renderStandard(renderState);
			mode = 'standard';
		}
		if (frameChoice === 'deep' || frameChoice === 'held') {
			const current = targetFrame !== null && lastDeepIterationRenderSignature === targetFrame;
			const preview = current ? null : getDeepPreviewTransform(renderState);
			if (deepMetricSource && frameCompatible(deepFrame, renderState, width, height) && (current || preview)) {
				iterationRenderer = deepMetricSource;
				deepPreviewTransform = preview;
			}
		}
		if (!iterationRenderer) {
			mode = chooseFallback(renderState.zoom);
			iterationRenderer = mode === 'placeholder' ? PLACEHOLDER_METRIC_SOURCE : renderStandard(renderState);
		}
		displayRenderer = resources.displayPass(
			renderState,
			iterationRenderer,
			deepPreviewTransform,
			buildPaletteTextureSource(),
			getInsideColor(),
			colorsVersion,
		);
		profiler.measureGL('display:draw (GPU)', () => displayRenderer.draw());

		maybeShowDeepZoomModeNotice(requestedDeepZoom, deepZoomSupport);
		if (import.meta.env.DEV)
			window.fractalDiagnostics = {
				mode,
				reference: deepZoomManager.referenceSignature,
				frame: lastDeepIterationRenderSignature,
				formula: deepFrame?.formula,
				width: canvas.width,
				height: canvas.height,
				workerDurationMs: deepZoomManager.workerDurationMs,
				textureBytes: deepZoomManager.textureBytes,
				pending: pendingDeepSignature,
				moving: isDeepInteractionInMotion,
				targetFrame,
				pendingReference: deepZoomManager.pendingReferenceSignature,
				preview: deepPreviewTransform,
				invalidPixels: invalidDeepPixels,
				repairedPixels: repairedDeepPixels,
				jobs: structuredClone(deepZoomManager.jobCounts),
			};
		profiler.tick(time);
	}

	const render = frameLoop(renderFrame, {
		schedule: callback => requestAnimationFrame(callback),
		report: error => showError(error),
	});

	const instructionsContainer = bindPointerControls({
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
	});

	bindKeyboardControls({
		state,
		updateColors,
		setResolutionMultiplier,
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
		getResolutionMultiplier: () => resolutionMultiplier,
		exportFrame: () => {
			if (displayRenderer) save(displayRenderer, 'fractal.png', null, { preventShare: true });
		},
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
}
