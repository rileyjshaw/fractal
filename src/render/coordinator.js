import { frameCompatible, previewCovered } from './frame.js';
export function chooseFrame({ requested, supported, referenceReady, frame, state, width, height }) {
	if (requested && supported && referenceReady) return 'deep';
	if (requested && supported && frameCompatible(frame, state, width, height)) return 'held';
	return 'standard';
}
export function canDeferFrame({ moving, frame, state, width, height, preview }) {
	return (
		moving &&
		frameCompatible(frame, state, width, height) &&
		previewCovered(preview, width, height) &&
		preview.scale > 0.35
	);
}
