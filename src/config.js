import { FORMULAS } from './domain/formulas.js';
export { MIN_EXPONENT, MAX_EXPONENT } from './domain/formulas.js';
export const MIN_ZOOM = 1;
export const STANDARD_RENDER_SAFE_MAX_ZOOM = 1e12;
export const MAX_ZOOM_DECIMAL_EXPONENT = 400;
export const DEEP_ZOOM_THRESHOLD = 16;
export const MAX_CONSTANT_COMPONENT = 2.5;
export const MIN_RESOLUTION_MULTIPLIER = 0.0625;
export const MAX_RESOLUTION_MULTIPLIER = 2;
export const MIN_ESCAPE_RADIUS = 0.8;
export const MAX_ESCAPE_RADIUS = 2;
export const MIN_COLOR_SCALE = 0.02;
export const MAX_COLOR_SCALE = 8.0;
export const MIN_SLOPE_LIGHT_HEIGHT = 0.1;
export const MAX_SLOPE_LIGHT_HEIGHT = 4;
export const MIN_SLOPE_LIGHT_INTENSITY = 0;
export const MAX_SLOPE_LIGHT_INTENSITY = 2;
export const SLOPE_LIGHT_ANGLE_STEP = 5;
export const SLOPE_LIGHT_HEIGHT_STEP = 0.1;
export const SLOPE_LIGHT_INTENSITY_STEP = 0.05;
export const MIN_SPEED = 0.1;
export const MAX_SPEED = 8;
export const BASE_ITERATIONS = 256;
// Floor for the deep iteration budget. Picked high enough that the iteration
// range gives palette cycling room (low values cluster everything near the
// cap and the color range collapses). Per-frame shader cost is offset by the
// palette-texture optimization moving display:draw from ~5ms to <1ms.
export const DEEP_MIN_ITERATIONS = 8192;
export const DEEP_MAX_ITERATIONS = 65536;
export const DEEP_ITERATION_ZOOM_FACTOR = 384;
export const DEEP_COMPATIBLE_REFERENCE_MAX_OFFSET = 2.5;
// Reference reuse policy; pixel correctness is checked independently.
export const DEEP_REFERENCE_RECENTER_OFFSET = 2.0;
export const DEEP_SETTLED_REFERENCE_RECENTER_OFFSET = 1.0;
// Start computing the deep reference orbit this many zoom units before crossing the
// deep-zoom threshold so the orbit is ready by the time the user actually needs it.
export const DEEP_ZOOM_PREPARATION_MARGIN_EXPONENT = 3;
export const DEEP_REFERENCE_ITERATION_HEADROOM_EXPONENT = 12;
// Coarse quantum applied to the reference-orbit iteration count so the trigger
// (stored < target) doesn't fire every zoom unit. Sized to cover several zoom
// units of u_iterations growth per recompute.
export const DEEP_REFERENCE_ITERATION_QUANTUM = 4096;
export const DEEP_INTERACTION_MOTION_SETTLE_MS = 200;
// Reproject the held metric frame during interaction; refresh once it is magnified by
// more than ~3x. Zooming out or panning uncovers the view, which already forces a refresh.
export const DEEP_PREVIEW_REFRESH_MIN_SCALE = 0.35;
// Past this zoom the standard renderer's float32 view coordinates no longer resolve
// the view, so a deep view without a usable frame shows an inside-colour placeholder.
export const STANDARD_FALLBACK_MAX_ZOOM_EXPONENT = 24;
export const SHOW_ZOOM_MODE_NOTICES = import.meta.env?.DEV ?? false;

export const ORBIT_TEXTURE_OPTIONS = {
	internalFormat: 'RGBA32F',
	format: 'RGBA',
	type: 'FLOAT',
	minFilter: 'NEAREST',
	magFilter: 'NEAREST',
	wrapS: 'CLAMP_TO_EDGE',
	wrapT: 'CLAMP_TO_EDGE',
	preserveY: false,
};

export const METRIC_TEXTURE_OPTIONS = {
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
export const PALETTE_TEXTURE_OPTIONS = {
	internalFormat: 'SRGB8_ALPHA8',
	format: 'RGBA',
	type: 'UNSIGNED_BYTE',
	minFilter: 'LINEAR',
	magFilter: 'LINEAR',
	wrapS: 'REPEAT',
	wrapT: 'CLAMP_TO_EDGE',
	preserveY: false,
};

export const FRACTAL_TYPES = FORMULAS.map(formula => formula.name);

export const MIN_ZOOM_EXPONENT = Math.log(MIN_ZOOM) / Math.log(2);
export const MAX_ZOOM_EXPONENT = MAX_ZOOM_DECIMAL_EXPONENT / Math.log10(2);
export const STANDARD_RENDER_SAFE_ZOOM_EXPONENT = Math.log(STANDARD_RENDER_SAFE_MAX_ZOOM) / Math.log(2);
