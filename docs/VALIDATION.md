# Deep-zoom cleanup validation

The supplied circular-seam view is stored in `tests/fixtures/circular-seam.json`. Tests freeze resolution and iteration budget, render RGBA32F metrics with the production shaders, and compare sampled pixels against an independent direct MPFR calculation in `tests/helpers/oracle.js`.

## Observations

- Before correction, accelerated/scalar normals differed by up to 1981 of 4094 angular bins (about 174 degrees) in the fixture.
- With scale-correct derivative updates and the conservative BLA threshold, the maximum difference in that fixture is zero bins. At this radius the tighter bound declines acceleration; a separate greater-depth case verifies that acceleration remains active.
- Sampled smooth escape and normal values at nearby radii 1e-10, 2e-10 and 4e-10 pass MPFR comparisons, including a reference shifted by a quarter radius.
- The full app renders the saved view without JavaScript or WebGL errors. Its screenshot is emitted to `output/playwright/circular-seam-fixed.png`.
- One worker benchmark of the fixture completed in approximately 668 ms while the browser advanced 47 animation frames. Its orbit data matched the local builder exactly. Texture payload was 147456 bytes (144 KiB), compared with the old fixed 46 MiB. These are local measurements, not cross-device performance guarantees; longer references allocate larger tables.
- Tests preserve one-radius navigation and reverse navigation through radius 1e-400, and reject incompatible cached frames and uncovered previews.

## Scope and limits

These results validate the saved scene and the tested cases, not all possible fractal locations. BLA stripe history is approximate, the iteration budget is finite, and demanding GPU passes can still stall despite worker-based reference preparation. Direct MPFR repair prioritizes correctness and may be expensive when many pixels need it. Cross-browser and physical-GPU testing remains useful; CI runs Chromium with software WebGL for reproducibility.

Run `npm run check` and `npm run test:gpu` to reproduce the checks. Install the test browser once with `npx playwright install chromium` (CI also installs Linux system dependencies). The build currently reports existing absolute font URLs resolved by the hosting environment and a large application bundle; neither is treated as a numerical test failure.

## Rapid Julia navigation

The zoom regression uses center `-0.50267735688078976448664 - 0.213776001900282709822774i`, Julia constant `-0.71 - 0.43i`, and zoom 60. Before progressive publication, zooming to 60.5 at 960×600 left the entire previous frame magnified by √2 for more than 15 seconds while 3813 invalid pixels were repaired. The new test requires a completed, repaired frame within three times the longest frame of the wait (the render and its readback) plus three seconds; see "GPU timing on shared hosts". Frames stay coherent during repair; no unresolved pixels or borrowed metrics are published. Sparse parallel repair and precision-doubling checks avoid publishing partial frames. Adaptive repair is compared with the original full-precision calculation, including the deeper zoom-83.75 gap fixture supplied during testing. The dense Julia comparison validates repaired pixels; the original perturbation pixels can still differ near sensitive boundaries.

A second regression interleaves 200 wheel events with clicks across ten zoom levels, waits for the final view to finish, and compares it with a fresh load of its saved URL. Worker unit tests verify that superseded jobs cannot publish late progress updates. These checks run in Chromium; physical-GPU and Firefox checks remain useful.

## Jobs during continuous input

Previously, every wheel event started a new reference job once the current reference could no longer draw the view. Each new job terminated the one before, so none finished until input stopped. Repairs were cancelled the same way. The policies are unit-tested with fake workers and plain inputs:

- kept and replaced references
- deferred renders while a repair is pending
- the frame loop surviving errors
- job counters
- failure memory

A browser regression sends a wheel event every 50 ms for six zoom units at the Julia view above. It requires no reference or repair job to be cancelled or to fail during the burst, at least one job to complete, and at least one new deep frame to appear before input stops. A second test checks that after a reset, returning to the same depth elsewhere shows the placeholder, not the old frame.

## Julia references

Reference search at the documented Julia views was measured before any numerical change:

| View | Budget | Newton | Reference length |
| --- | --- | --- | --- |
| zoom 60 | 25088 | none | 447 (sampling) |
| zoom 83.75 | 34208 | none | 552 (sampling) |
| zoom 120, 170 (same center) | 48128, 65536 | none | 530 |

- The constant −0.71 − 0.43i lies outside the Mandelbrot set: its critical orbit escapes after 9 steps. The Julia set has no interior, and every reference escapes.
- Newton detects period 266 but converges only about 700 radii away. Even that periodic point's direct orbit escaped after 1925 steps.
- The invalid pixels at these views are those that outlast a 447–552-step sampled reference. This change does not reduce them. It would need a different reference search, such as a secondary reference placed at an invalid pixel.

Where Newton does converge, the found cycle is now repeated. For Julia sets with interior, the old behaviour left every interior pixel invalid:

- **Unit gate** (`test/juliaReference.test.js`). View at c = 0.3274 + 0.1945i, radius 1e-40, beside the repelling fixed point. The directly iterated fixed point escapes after 711 steps against a 2048 budget. The repeated reference covers 2082 samples. A double-precision mirror of the shader step matches direct MPFR escape iterations for all 35 sampled pixels (13 interior, 22 escaped), with a maximum smooth escape error of 0.0011.
- **GPU check** (`numerics.spec.js`). Renders the same view at 48×30 with a 1024 budget:
  - With a 1024-sample reference, pixels must be exhausted.
  - With 1058 samples, none may be invalid, and coverage must match direct MPFR repair for every pixel.
  - Every escaping pixel must be bit-identical to a render from the directly iterated fixed point, which stays on the cycle well past those pixels' escape.
  - A CPU mirror of that grid finds 491 interior pixels. Its closest approach to the cancellation rule is |z|²/|Z|² = 1.9e-4, against a threshold of 1e-8.
- **Sensitive pixel.** Of the 949 escaping pixels, the median smooth escape error against MPFR is 1.5e-5, but one pixel is 0.119 off (0.131 without BLA). A double-precision mirror shows the same 0.119 with the repeated cycle and with the directly iterated orbit. The error therefore comes from float32 reference samples at a sensitive pixel, not from repeating the cycle. The test records the maximum but does not bound it absolutely.

## GPU timing on shared hosts

Software WebGL timing varies severalfold with host load, so the zoom tests avoid fixed short budgets.

`zoom.spec.js` "Julia repair presents a complete frame without a long preview" originally required the view to settle within 5 s at 960×600. Measurements on one host:

| Host state | Settle frame (render + readback) | Repair | Total, `5429cac` | Total, this change |
| --- | --- | --- | --- | --- |
| Quiet | 2.5–2.7 s | about 1 s | 3.9–4.3 s | 3.6–3.7 s |
| Loaded | 4.4–5.6 s | about 2 s | 6.9–8.0 s | 6.3–6.6 s |

With the 5 s budget, `5429cac` failed in all four attempts in one loaded run, and this change failed in one of three full suite runs. The test now measures the longest frame while waiting, which is the render of the new view, and requires the repaired frame within three times that plus 3 s. Repair that dominates the render, as it did before sparse parallel repair (more than 15 s after a render of a few seconds), still fails.

The 40-step "zoom settles" test keeps its 15 s limit per step. It is marked slow because the steps together passed the default 120 s test timeout on a loaded host.
