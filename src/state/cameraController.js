import { getApproximatePositionFromCenterComponent, getRadiusExactForZoom } from '../viewMath.js';
export function createCameraController({
	state,
	smoothedZoom,
	smoothedPosition,
	deepZoomManager,
	initializeDeepZoom,
	beginDeepInteractionMotion,
	persistStateToHash,
	positionTween,
	isDeepZoomRequested,
}) {
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

	function getCurrentRadiusExact() {
		return Math.abs(smoothedZoom[0] - state.zoom) < 1e-9
			? state.deepRadius
			: getRadiusExactForZoom(smoothedZoom[0]);
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
			deepZoomManager
				.initialize()
				.then(() => translatePreciseCenter(deltaReal, deltaImag, radiusExact))
				.catch(initializeDeepZoom);
			return true;
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

	return {
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
	};
}
