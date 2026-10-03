## Why

Deep zoom stalls during continuous input. Reference and repair jobs are cancelled by every wheel or click event, so none finish until input stops. Julia and Mandala views also mark pixels invalid when the reference orbit runs out, which sends them to slow CPU repair. The app has further gaps: an expensive and meaningless fallback render, a stale frame after reset, inconsistent invalid-pixel checks, a render loop that stops on one error, and failures that retry every frame.

## What Changes

- In-flight reference jobs are kept while the user is moving if they can still serve the view. When settled, they are kept if their result is predicted to be usable.
- While moving, a pending repair suppresses new deep renders. A finished repair for an older compatible view becomes the held frame the preview is drawn from.
- Reference orbits include `REFERENCE_ORBIT_RUNOFF` samples beyond the iteration budget. This uses one constant shared with the orbit capacity, metric repair and the BLA builder.
- Julia and Mandala references must cover the full budget plus runoff. A short Newton orbit falls back to the sampling search, and the longer orbit wins.
- A converged Julia periodic point is repeated as an exact cycle to fill the reference. For Julia, Newton runs until its step is below 2^-40 of its search bound, compared in MPFR.
- Without a usable deep frame beyond float32 resolution, the app shows an inside-colour placeholder. Below that depth it shows a cached standard render.
- Reset clears the held deep frame. Held frames require a preview transform.
- Negative coverage and non-finite components are both treated as invalid, via one shared `isInvalidMetric`.
- The render loop always schedules the next frame and reports repeated errors once.
- A failed reference or repair is not retried until the view changes.
- The coordinator uses `DEEP_PREVIEW_REFRESH_MIN_SCALE`. The unused max-scale constant is removed.
- Worker job counters are exposed in `fractalDiagnostics.jobs`.

## Impact

- Code: `src/app.js`, `src/render/coordinator.js`, `src/render/scheduling.js`, `src/render/metric.js`, `src/deep/referenceService.js`, `src/deep/repairPool.js`, `src/deepZoom.js`, `src/deepZoomTables.js`, `src/gmpUtils.js`, `src/shaderCommon.js`, `src/config.js`.
- Docs: `docs/ARCHITECTURE.md` (stale-repair rule, fallback, references), `docs/VALIDATION.md` (measurements).
- Tests: unit tests for policies, counters, invalid metrics, loop recovery, retry memory, orbit length, BLA bounds and Julia cycle references; browser tests for a wheel burst, reference exhaustion and reset.
- Not changed: full-resolution float readback per render (known performance cost), and reference search strategy for Julia constants outside the Mandelbrot set (see design).
