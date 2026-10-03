import { frameCompatible, previewCovered } from './frame.js';
import {
	DEEP_COMPATIBLE_REFERENCE_MAX_OFFSET,
	DEEP_PREVIEW_REFRESH_MIN_SCALE,
	STANDARD_FALLBACK_MAX_ZOOM_EXPONENT,
} from '../config.js';

// A held frame needs a preview transform: without its anchor the frame would be
// drawn unscaled at whatever location it came from.
export function chooseFrame({ requested, supported, referenceReady, frame, state, width, height, preview }) {
	if (!requested || !supported) return 'standard';
	if (referenceReady) return 'deep';
	return preview && frameCompatible(frame, state, width, height) ? 'held' : 'fallback';
}

// What replaces a deep frame that cannot be drawn. Float32 view coordinates stop
// resolving the view past STANDARD_FALLBACK_MAX_ZOOM_EXPONENT, where the standard
// renderer would paint one flat, misleading colour.
export function chooseFallback(zoom) {
	return zoom > STANDARD_FALLBACK_MAX_ZOOM_EXPONENT ? 'placeholder' : 'standard';
}

export function canDeferFrame({ moving, frame, state, width, height, preview }) {
	return (
		moving &&
		frameCompatible(frame, state, width, height) &&
		previewCovered(preview, width, height) &&
		preview.scale > DEEP_PREVIEW_REFRESH_MIN_SCALE
	);
}

// Deep-pass work for the current view:
//   'hold'   the view is already published, being repaired, or failed to repair.
//   'defer'  keep reprojecting the held frame.
//   'render' iterate the view now.
// Rendering during motion would cancel a pending repair, and the next event would
// cancel its replacement, so nothing would publish until input stops. Instead the
// repair finishes and its frame becomes the preview source.
export function planDeepStep({ target, rendered, pending, failed, pendingFrame, ...view }) {
	if (target === rendered || target === pending || target === failed) return 'hold';
	const { moving, state, width, height } = view;
	if (moving && pending && frameCompatible(pendingFrame, state, width, height)) return 'defer';
	return canDeferFrame(view) ? 'defer' : 'render';
}

// Whether an in-flight reference job should run to completion instead of being
// replaced by a job for the current view. During motion every event changes the view,
// so replacing jobs would starve them all. When settled, keep a job whose result
// (up to `reach` radii off-center) can still draw the view.
export function keepPendingReference({ moving, pending, target, reach }) {
	if (!pending || pending.formula !== target.formula || pending.iterations < target.iterations) return false;
	return moving || reach <= DEEP_COMPATIBLE_REFERENCE_MAX_OFFSET;
}

// Animation loop that survives a throwing frame. The next frame is scheduled first so
// a lost context or failed readback cannot freeze the canvas, and a repeated error is
// reported once until a frame succeeds.
export function frameLoop(renderFrame, { schedule, report }) {
	let lastError = null;
	const loop = time => {
		schedule(loop);
		try {
			renderFrame(time);
			lastError = null;
		} catch (error) {
			const message = String(error?.message ?? error);
			if (message !== lastError) report(error);
			lastError = message;
		}
	};
	return loop;
}
