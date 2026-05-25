// Diagnostic profiler. OFF by default — overhead is non-trivial when ON because
// measureGL forces gl.finish() to get accurate GPU timing (kills GPU/CPU pipelining).
//
// Toggle with KeyP. Dumps aggregated phase times to console every DUMP_INTERVAL_MS.
//
// Usage:
//   import * as profiler from './profiler.js';
//   profiler.setGlContext(canvas.getContext('webgl2'));
//   const result = profiler.measure('label', () => someSyncWork());
//   await profiler.measureAsync('label', () => someAsync());
//   profiler.measureGL('label', () => shaderPad.draw());  // forces gl.finish()
//   profiler.tick(time);  // call once per frame; dumps when interval elapsed

const DUMP_INTERVAL_MS = 5000;

let samples = {};
let lastDumpMs = 0;
let isEnabled = false;
let canvasRef = null;
let glContext = null;
// EXT_disjoint_timer_query_webgl2 — when available, measureGL queues timer queries
// instead of forcing gl.finish(). Removes the GPU-pipeline-killing CPU↔GPU sync
// so per-shader timings are honest AND profiler-on perf isn't catastrophic.
let timerExt = null;
let timerExtChecked = false;
const pendingQueries = [];

// Hold the canvas, NOT the GL context. Fetching the WebGL context preempts
// ShaderPad's first-getContext call (WebGL options only apply on the first call
// to a given canvas), which silently broke the iteration FBO output. We fetch
// the context lazily inside measureGL, by which time ShaderPad has long since
// initialised it and the call just returns the already-cached context.
export function setCanvas(canvas) {
	canvasRef = canvas;
}

function getGlContext() {
	if (glContext) return glContext;
	if (!canvasRef) return null;
	glContext = canvasRef.getContext('webgl2') ?? canvasRef.getContext('webgl');
	return glContext;
}

function getTimerExt() {
	if (timerExtChecked) return timerExt;
	const gl = getGlContext();
	if (gl) {
		// WebGL2's timer extension is named with the _webgl2 suffix. WebGL1 has its
		// own variant; we ignore it because the rest of the app requires WebGL2.
		timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
	}
	timerExtChecked = true;
	return timerExt;
}

function drainPendingQueries() {
	const gl = getGlContext();
	const ext = timerExt;
	if (!gl || !ext) return;
	while (pendingQueries.length > 0) {
		const { query, label } = pendingQueries[0];
		const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
		if (!available) break; // queue is in order; if head isn't ready, neither are the rest
		// GPU_DISJOINT_EXT being set means the timing results are unreliable for
		// this period (driver reset, throttling, etc). Discard such queries.
		const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
		if (!disjoint) {
			const timeNs = gl.getQueryParameter(query, gl.QUERY_RESULT);
			record(label, timeNs / 1_000_000);
		}
		gl.deleteQuery(query);
		pendingQueries.shift();
	}
}

function discardPendingQueries() {
	const gl = getGlContext();
	if (!gl) {
		pendingQueries.length = 0;
		return;
	}
	for (const { query } of pendingQueries) gl.deleteQuery(query);
	pendingQueries.length = 0;
}

export function isOn() {
	return isEnabled;
}

export function toggle() {
	isEnabled = !isEnabled;
	if (isEnabled) {
		samples = {};
		lastDumpMs = 0;
		const usingTimerExt = !!getTimerExt();
		// eslint-disable-next-line no-console
		console.log(
			`[profiler] enabled — GPU timing via ${usingTimerExt ? 'EXT_disjoint_timer_query_webgl2 (no pipeline kill)' : 'gl.finish() fallback (kills pipelining)'}`,
		);
	} else {
		discardPendingQueries();
		// eslint-disable-next-line no-console
		console.log('[profiler] disabled');
	}
	return isEnabled;
}

function record(label, durationMs) {
	if (!samples[label]) {
		samples[label] = { count: 0, total: 0, max: 0 };
	}
	const s = samples[label];
	s.count += 1;
	s.total += durationMs;
	if (durationMs > s.max) s.max = durationMs;
}

export function measure(label, fn) {
	if (!isEnabled) return fn();
	const t0 = performance.now();
	const result = fn();
	record(label, performance.now() - t0);
	return result;
}

export async function measureAsync(label, fn) {
	if (!isEnabled) return fn();
	const t0 = performance.now();
	const result = await fn();
	record(label, performance.now() - t0);
	return result;
}

// GL calls are fire-and-forget: gl.draw/step return immediately and the GPU
// runs the shader asynchronously. Without a sync point, JS-side timing measures
// only the dispatch cost (microseconds), not the real shader execution time.
//
// Primary path: EXT_disjoint_timer_query_webgl2 timestamps the work on the GPU
// itself. Results are async (available a frame or two later) so we queue them
// and drain in tick(). No CPU↔GPU sync penalty.
//
// Fallback (when extension is unavailable): gl.finish() forces a hard sync.
// Kills pipelining and bloats per-frame cost but gives an approximate number.
export function measureGL(label, fn) {
	if (!isEnabled) return fn();
	const gl = getGlContext();
	if (!gl) return fn();
	const ext = getTimerExt();
	if (ext) {
		const query = gl.createQuery();
		// TIME_ELAPSED queries can't be nested — measureGL calls in the render loop
		// are sequential so this is fine, but worth noting if anyone refactors.
		gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
		const result = fn();
		gl.endQuery(ext.TIME_ELAPSED_EXT);
		pendingQueries.push({ query, label });
		return result;
	}
	const t0 = performance.now();
	const result = fn();
	gl.finish();
	record(label, performance.now() - t0);
	return result;
}

export function note(label, value) {
	if (!isEnabled) return;
	if (!samples[label]) {
		samples[label] = { count: 0, total: 0, max: 0 };
	}
	const s = samples[label];
	s.count += 1;
	s.total += value;
	if (value > s.max) s.max = value;
}

export function tick(nowMs) {
	if (!isEnabled) return;
	drainPendingQueries();
	if (lastDumpMs === 0) {
		lastDumpMs = nowMs;
		return;
	}
	if (nowMs - lastDumpMs < DUMP_INTERVAL_MS) return;
	dump(nowMs - lastDumpMs);
	samples = {};
	lastDumpMs = nowMs;
}

function dump(intervalMs) {
	const rows = Object.entries(samples)
		.map(([label, s]) => ({
			label,
			count: s.count,
			'avg (ms)': Number((s.total / s.count).toFixed(2)),
			'max (ms)': Number(s.max.toFixed(2)),
			'total (ms)': Number(s.total.toFixed(0)),
			'% wall': Number(((s.total / intervalMs) * 100).toFixed(1)),
		}))
		.sort((a, b) => b['total (ms)'] - a['total (ms)']);
	// eslint-disable-next-line no-console
	console.groupCollapsed(`[profiler] ${(intervalMs / 1000).toFixed(1)}s window`);
	// eslint-disable-next-line no-console
	console.table(rows);
	// eslint-disable-next-line no-console
	console.groupEnd();
}
