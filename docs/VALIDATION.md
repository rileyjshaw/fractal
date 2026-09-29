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

The zoom regression uses center `-0.50267735688078976448664 - 0.213776001900282709822774i`, Julia constant `-0.71 - 0.43i`, and zoom 60. Before progressive publication, zooming to 60.5 at 960×600 left the entire previous frame magnified by √2 for more than 15 seconds while 3813 invalid pixels were repaired. The new test requires a completed frame within five seconds. Frames stay coherent during repair; no unresolved pixels or borrowed metrics are published. Sparse parallel repair and precision-doubling checks avoid publishing partial frames. Adaptive repair is compared with the original full-precision calculation, including the deeper zoom-83.75 gap fixture supplied during testing. The dense Julia comparison validates repaired pixels; the original perturbation pixels can still differ near sensitive boundaries.

A second regression interleaves 200 wheel events with clicks across ten zoom levels, waits for the final view to finish, and compares it with a fresh load of its saved URL. Worker unit tests verify that superseded jobs cannot publish late progress updates. These checks run in Chromium; physical-GPU and Firefox checks remain useful.
