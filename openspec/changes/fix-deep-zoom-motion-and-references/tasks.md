## 1. Setup

- [x] 1.1 Rebuild the review branch on `codex/deep-zoom-cleanup` and commit the staged work
- [x] 1.2 Measure Julia reference search (Newton success, orbit lengths) before numerical changes

## 2. Shared constants and checks

- [x] 2.1 Add `STRIPE_RUNOFF_LIMIT` and `REFERENCE_ORBIT_RUNOFF` to `shaderCommon.js`; use them in the GLSL, `gmpUtils`, `metric.js` and the BLA builder
- [x] 2.2 Add `isInvalidMetric`; use it in the app count, `RepairPool` and `repairMetrics`
- [x] 2.3 Use `DEEP_PREVIEW_REFRESH_MIN_SCALE` in the coordinator; remove the unused max constant

## 3. References

- [x] 3.1 `getReferenceIterationCount` adds runoff to the quantized budget
- [x] 3.2 BLA stride from orbit length minus runoff; stop composition at the stride
- [x] 3.3 Julia Newton step tolerance relative to the bound, compared in MPFR; report `converged`
- [x] 3.4 `computePeriodicReferenceData` repeats a closed high-precision cycle
- [x] 3.5 Center-seeded acceptance threshold; sampling fallback keeps the longer orbit

## 4. Scheduling and app

- [x] 4.1 `keepPendingReference`, `planDeepStep`, `chooseFrame` (preview and placeholder), `frameLoop`
- [x] 4.2 `ReferenceService`: pending state, reach estimate, failure memory, job counters (reference and repair)
- [x] 4.3 App: apply policies, stale repair publication, repair failure memory, placeholder and cached fallback, reset/resize clearing, diagnostics

## 5. Tests and docs

- [x] 5.1 Unit tests: coordinator policies, loop recovery, counters and failure memory, invalid metrics, reference count, BLA bounds, Julia cycle reference against MPFR
- [x] 5.2 Browser tests: wheel burst job counters and in-motion frames, reference exhaustion fixture, reset
- [x] 5.3 Update `docs/ARCHITECTURE.md` and `docs/VALIDATION.md`
- [x] 5.4 `npm run check` passes
- [x] 5.5 `env CI=1 npm run test:gpu` on the host. Replace the absolute MPFR smooth bound in the Julia fixture with exact agreement with the directly iterated orbit: one float32-sensitive pixel is 0.119 off with either reference.
- [x] 5.6 Commit the fixes once all four checks pass
- [x] 5.7 Make the zoom timing tests independent of host load: bound repair relative to the render it follows, and mark the 40-step test slow
