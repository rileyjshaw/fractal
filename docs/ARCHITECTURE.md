# Rendering and state contracts

## Ownership

`main.js` handles CSS, service-worker registration and startup. `app.js` composes the application, advances camera/palette time, and schedules frames. It does not allocate shaders or implement input bindings.

| Module | Owns |
| --- | --- |
| `state/viewState.js`, `state/urlState.js` | Validation, legacy hash compatibility, canonical decimal-string camera values |
| `state/cameraController.js` | Translation, zoom and the approximate projection used by shallow interpolation |
| `ui/controls.js`, `ui/pointerControls.js` | Keyboard, mouse, touch and help bindings, expressed through application actions |
| `render/coordinator.js`, `render/frame.js`, `render/scheduling.js` | Frame choice, job policies during motion, the frame loop, frame compatibility, preview coverage and iteration budgets |
| `render/resources.js` | ShaderPad lifetimes, uniforms, texture uploads and metric readback |
| `deep/referenceService.js`, `deep/workerClient.js` | Asynchronous reference/repair jobs, cancellation and publication |
| `deep/reference.worker.js`, `deepZoom.js` | Reference selection, high-precision orbits and acceleration tables |
| `math/precision.js`, `gmpUtils.js` | Precision policy and MPFR lifetimes |
| `standardShader.js`, `perturbationShader.js`, `shaderCommon.js`, `deepDisplayShader.js` | Iteration kernels, metric encoding and presentation |

## Camera and precision

Deep centers are decimal strings, never offsets accumulated in JS doubles. Legacy X/Y hash values are projections of A/B when both are supplied. W preserves the radius string; Z is the approximate base-2 zoom used by controls. Invalid fields are ignored individually, numeric controls are bounded, and fractional formula exponents are rejected.

Precision is selected from the ratio of center magnitude to view radius, viewport resolution, and 64 guard bits. GMP instances retain at least 1200 bits and increase as needed; precision does not shrink while work is in progress. The configured navigation limit is approximately 400 decimal orders of zoom. Test coverage includes one-radius pan and reverse-pan at radii 1e-350, 1e-370 and 1e-400. This is a navigation limit, not a guarantee that a fixed iteration budget resolves every fractal feature.

The radius helper's `Exact` suffix means a preserved decimal representation. Fractional powers of two used to generate it are approximate.

## Numerical rendering

Every supported formula/exponent pair is compiled into a specialized iteration shader. Quadratic Mandelbrot/Julia can use hierarchical bivariate linear approximation (BLA). Other variants use scalar perturbation.

The derivative is represented as `D = m * exp(L)`. Both scalar and BLA affine updates align additive terms with that representation before summing. BLA uses a conservative local perturbation threshold of 1e-6; it can decline to accelerate an entire view. Its bound is not a general proof of final-image accuracy, so GPU/MPFR regressions remain necessary.

Mandelbrot and Burning Ship can rebase to their zero seed before severe cancellation or at reference exhaustion. Julia/Mandala cannot treat a rounded reconstruction as an exact new seed; detected cancellation or reference exhaustion marks the pixel invalid. Deep iteration does not infer a cycle from equality of rounded reconstructed z values.

References therefore extend `REFERENCE_ORBIT_RUNOFF` samples past the quantized budget: one for the sample the loop reads ahead, plus the stripe runoff. At the iteration cap this is 65570 samples. The reference search accepts a Julia/Mandala orbit only if it covers the budget plus runoff. Zero-seeded formulas keep a 95% threshold, because they rebase. If Newton's orbit falls short, the sampling search runs, and the longer orbit wins.

Julia periodic points are repelling. At finite precision, their directly iterated orbit leaves the cycle and escapes. In the unit-test fixture (c = 0.3274 + 0.1945i, a 1e-40 view beside the repelling fixed point), it escaped after 711 steps. A Newton point is therefore repeated as one high-precision period once its last step is below 2^-40 of the search bound. That bound makes the repeated cycle stand in for the exact periodic point far inside a pixel. Mandelbrot nuclei are superattracting and stay directly iterated.

The metric format is versioned in `render/metric.js`:

- R: smooth escape count, or zero when the iteration budget ends without escape.
- G: stripe palette offset.
- B: packed brightness and optional normal angle.
- A: coverage. Negative coverage marks a numerical failure requiring repair.

A metric is invalid if its coverage is negative or any component is non-finite. `isInvalidMetric` is the only definition, used by the frame count, the repair pool and repair itself. Invalid pixels are recomputed from direct MPFR pixel orbits in a worker, then converted to the same metric format. Frames are published only after all invalid pixels are repaired; metrics from different views are never spliced together. A compatible previous frame remains visible while repair runs. Progress updates are diagnostic only. Repair computations start at the view's precision requirement plus 64 bits and compare their float32 metrics with a calculation at doubled precision. Disagreement increases precision up to the existing GMP precision. This is a convergence check, not a proof of numerical accuracy. A budget-exhausted pixel is still not a proof of mathematical interior membership.

BLA interval minima use an interval summary, not the reference's whole-prefix minimum. Stripe prefix contributions approximate the pixel's stripe history with the reference's history; this remains an approximation requiring validation, particularly in new extreme-depth scenes.

## Frames, workers and resources

A completed frame descriptor records formula identity, camera, iteration budget, escape radius, precision, resolution, reference identity and metric schema. Reprojection requires compatible formula/escape settings and dimensions. It also requires the frame's anchor, its camera: a held frame without one is never drawn. Reset and resize clear the frame, its source and its anchor. Reprojection can defer a fresh iteration only when the entire destination viewport is covered by the held source, and only until the source is magnified by about 3x (`DEEP_PREVIEW_REFRESH_MIN_SCALE`). The compositor paints uncovered regions with the interior color instead of stretching source edge texels.

Without a usable deep frame, the app shows a standard render, recomputed only when its inputs change, while float32 still resolves the view. Beyond `STANDARD_FALLBACK_MAX_ZOOM_EXPONENT` (2^24), where the standard renderer would paint one flat, misleading colour, it shows a plain inside-colour placeholder instead.

Reference preparation uses one worker lane. Pixel repairs use up to four workers, capped by the reported CPU concurrency; only sparse pixel batches cross those worker boundaries. A frame is published atomically after every batch completes. A newer job cancels its predecessor by terminating its workers, including synchronous WASM work. Replies and progress updates carry increasing IDs, and late replies are ignored. Frame identity includes the camera, formula, budget and resolution, but not the reference chosen to calculate it, so replacement references cannot discard valid repairs for an unchanged view. Idle workers are reused. Small navigation arithmetic stays local so input does not wait behind a long reference search.

Continuous input changes the view every event, so jobs are not replaced during motion:

- An in-flight reference job is kept if it has the same formula and covers the render budget. Once input settles, it is kept only if its worst-case result can still draw the view: its center offset plus the search radius (`REFERENCE_SEARCH_RADIUS`, in the pending view's radii) must stay within 2.5 current radii.
- While a repair for a compatible view is pending, motion defers new deep renders. The pending repair would otherwise be cancelled by the next render, and its replacement by the event after.
- A finished repair for an older compatible view becomes the held frame the preview is drawn from. It never counts as the current view's frame, so the current view still renders afterwards. A repair for an incompatible view (formula, escape radius or resolution changed) is discarded.
- A failed reference or repair is not retried until its target view changes.
- The frame loop schedules the next frame before rendering, so an exception such as a failed readback cannot stop rendering. A repeated error is reported once.
- `fractalDiagnostics.jobs` counts started, completed, cancelled and failed reference and repair jobs.

Float arrays transfer ownership across the worker boundary. Orbit/prefix textures allocate only the required rows. BLA uses a power-of-two stride sized to the orbit without its runoff, with a minimum layout granularity. No entry composes children past the stride, which would read the next level. Shader addressing derives the stride from texture dimensions. The iteration budget is capped at 65536. References and direct repairs both reserve `REFERENCE_ORBIT_RUNOFF` samples beyond it for post-escape stripe runoff (`ORBIT_CAPACITY` = 65570). Orbit buffers start small and grow only as iteration proceeds, avoiding full-budget allocations for short escaping orbits.

The deep iteration pass uses an offscreen ShaderPad context. Its float output is read once per completed iteration pass, repaired if necessary, and uploaded to the display context. Palette-only frames reuse that source. This readback/upload is an explicit performance tradeoff for reliable repair, and can still synchronize CPU and GPU. Worker timing does not measure that GPU stall. The profiler's shared display-context timer should not be interpreted as an accurate separate-context deep GPU timer.

## Changes and release checks

Use `npm run check` for read-only lint/format checks, unit tests and the production build. `npm run format` is the explicit mutating formatter. Run `npm run test:gpu` after shader, camera, renderer or worker changes. CI executes both on pull requests and main before deployment, with locked dependencies (`npm ci`).

The GPU suite compiles all 120 iteration variants plus the display shader, compares the saved artifact scene and adjacent scales with scalar/MPFR results, tests alternative references and worker transfer parity, and exercises real application transitions. It uses deterministic metric images rather than relying on screenshot byte identity across graphics drivers. Screenshots and numerical diagnostics are saved as test artifacts. Palette extension is deterministic for saved views.

Historical reference plans and `TODO_RJS.md` are not current support documentation. New acceleration or coloring work must preserve these contracts and add representative numerical fixtures.
