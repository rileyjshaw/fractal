## Context

The previous read-only pass listed ten problems. The user decided three questions:

- A: A finished repair for an older compatible view may become the frame the preview is drawn from.
- B: Repeat a found Julia cycle, but only if high-precision reference tests pass; otherwise add only the fallback search.
- C: Show an inside-colour placeholder at deep zoom when no usable frame exists.

Item 4 was an inference and had to be measured before any numerical change.

## Measurements (before changes)

Reference search at the documented Julia views (c = −0.71 − 0.43i):

| View | Budget | Newton | Chosen reference length |
| --- | --- | --- | --- |
| zoom 60, r = 1.73e-18 | 25088 | none | 447 (sampling, offset 0.85 radii) |
| zoom 83.75, r = 1.23e-25 | 34208 | none | 552 (sampling) |
| zoom 120 | 48128 | none | 530 |
| zoom 170 | 65536 | none | 530 |

- The constant lies outside the Mandelbrot set: its critical orbit escapes after 9 steps. Its Julia set has no interior, and every reference escapes.
- Newton detects period 266. It converges only with a bound of 10⁶ radii, landing about 700 radii away. Even then (residual 5e-137), the MPFR orbit escapes after 1925 iterations.
- For the basilica (c = −1) at radius 1e-40, Newton finds α (period 2, residual 1e-163). Its orbit escapes after 886 iterations, while the view center's own orbit survives 16384. The current code accepts the 886-long orbit without a length check.

Conclusions:

- The inference holds where Newton succeeds: finite-precision repelling cycles drift off and escape.
- It does not explain the documented test views, where Newton finds nothing. The planned changes cannot produce a large drop in invalid pixels there. A different reference search, such as a secondary reference at an invalid pixel or a preperiodic pullback, would be needed. That is out of scope and reported.

## Decisions

1. **Pure policy functions in `render/coordinator.js`.** `chooseFrame`, `planDeepStep`, `keepPendingReference` and `frameLoop` take plain values and are unit-tested. `app.js` gathers inputs and applies results.
2. **Keeping reference jobs.**
   - While moving, a pending job is kept if the formula matches and its iteration count covers the render budget.
   - When settled, it is kept only if the worst-case offset of its result stays within `DEEP_COMPATIBLE_REFERENCE_MAX_OFFSET` for the current view. That bound is the current offset to the pending center plus the search radius, all in current radii.
   - The search radius is derived from the Newton bound and the sample offsets, so it is not duplicated.
3. **Repairs during motion.**
   - `planDeepStep` returns `defer` while moving if a repair is pending for a compatible view. No render or readback happens, so the pending repair is not cancelled.
   - When a repair finishes, it is published if its view is current, or if its frame is still compatible (decision A).
   - A stale publication records its own signature as the last rendered frame, so the current view still renders next.
4. **Reference length.**
   - `REFERENCE_ORBIT_RUNOFF = STRIPE_RUNOFF_LIMIT + 2` lives in `shaderCommon.js` beside the GLSL constant it mirrors.
   - `getReferenceIterationCount` returns the quantized budget plus runoff, so quantization still limits recomputation to coarse steps. At the cap this is 65570, which equals `ORBIT_CAPACITY`.
   - The compact BLA stride is sized from the orbit length minus runoff. A reference for 16384 iterations therefore keeps a 16384 stride instead of doubling it.
   - The builder never composes entries past the stride, which would otherwise alias into the next level once an orbit is longer than the stride.
5. **Julia/Mandala acceptance.**
   - Center-seeded formulas (`FORMULAS[type].seedsFromCenter`) cannot rebase. They require `min(target, required + runoff)` samples; zero-seeded formulas keep the 95% rule.
   - A Newton orbit below the threshold triggers the sampling search, and the longer orbit is kept.
6. **Cycle repeat (decision B).**
   - For Julia, Newton stops when its MPFR step squared falls below `min(existing absolute tolerance, (bound × 2^-40)²)`. Results report `converged`.
   - Mandelbrot keeps the absolute 1e-60 tolerance, so its numerics are unchanged. That tolerance makes Newton stop after its first step once the view radius is below about 1e-30. This is reported as a follow-up rather than changed here, because the GPU checks that would show its effect cannot run in this sandbox.
   - For Julia with a converged point, one period is computed in MPFR and checked to close in float32. It is then repeated to the target length.
   - Mandelbrot nuclei stay directly iterated, because their cycles are superattracting.
   - The change is gated on a Node test that compares CPU perturbation from the repeated reference with direct MPFR pixel orbits, plus the existing high-precision tests.
7. **Fallback (decision C).**
   - Held frames require a compatible frame and a preview transform (an anchor). Reset and resize clear the frame, its source and its anchor.
   - Without a usable frame: beyond `STANDARD_FALLBACK_MAX_ZOOM_EXPONENT` (24), a 1×1 inside-colour metric is displayed. Below it, the standard pass renders only when its signature changes.
8. **Robustness.**
   - `isInvalidMetric` in `metric.js` is used by the app count, the repair pool and repair itself.
   - `frameLoop` schedules before rendering and reports an error only when its message changes.
   - `ReferenceService` remembers a failed reference signature. The app remembers a failed repair signature. Neither is retried until the target signature changes.
9. **Branch base.** The isolated copy started at `origin/main`, while the code under repair is on `codex/deep-zoom-cleanup` plus 16 staged files in the original checkout. The review branch was moved to that commit, and the staged patch was applied byte-identically and committed. The original checkout is untouched.

## Risks

- Keeping a job during motion can finish with an unusable reference. A new job then starts from the latest view, so work completes instead of restarting on every event.
- Holding renders during a pending repair shows the reprojected frame longer while moving, but it updates each time a repair completes.
- The cycle repeat uses Newton's point as the reference center. Its error is bounded by the last Newton step, at most 2^-40 of the bound, far below a pixel.
- GPU tests cannot run in this sandbox, because binding a local port is denied. Browser tests are written but remain pending for host validation.
