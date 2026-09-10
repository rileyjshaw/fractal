# Fractal Explorer: GPU Edition

This project lets you zoom into, modify, and explore several fractal formulas in the browser. The standard renderer is fast and interactive, but it still hits floating point precision limits at relatively shallow zoom depths. An experimental deep zoom path is now wired in on top of [ShaderPad](https://misery.co/shaderpad) and [GMP-WASM](https://github.com/Daninet/gmp-wasm).

This project is just for fun and learning. Pull requests are welcome as long as the app stays performant and fun to explore.

![Example program output](/screenshots/fractal-1080p.jpg)

## Features

- Julia, Mandelbrot, Burning Ship, and Mandala formulas, each at any integer exponent from 2 to 16
- Deep zoom via perturbation theory with adaptive navigation precision
- Keyboard, mouse, and touch controls
- Animated palettes, stripe-average coloring, slope shading, distance-estimate anti-aliasing
- URL hash persistence for shareable views
- PNG frame export
- Works offline as a PWA

## How it works

Rendering is a two-pass pipeline: an iteration pass writes a per-pixel metric (smooth escape time, stripe value, packed visual data, coverage) to an `RGBA32F` framebuffer, and a display pass maps it through the palette, lighting, and an ACES tone map. Palette animation and visual toggles only re-run the cheap display pass.

Past the deep-zoom threshold the iteration pass switches to perturbation: [gmp-wasm](https://github.com/Daninet/gmp-wasm) computes a high-precision reference orbit (uploaded as a texture), and the shader iterates only each pixel's tiny delta from it, carried in mantissa/exponent form so it survives any depth.

- Quadratic Mandelbrot and Julia take the fast path: Newton-on-period reference search plus hierarchical bivariate linear approximation (BLA), which skips up to 2048 iterations at a time under a conservative perturbation bound.
- Burning Ship and Mandala perturb their `|z|` folds exactly (`diffabs`, correct across fold crossings); exponents above 2 use the binomial expansion of `(Z + δ)ᴺ − Zᴺ`. These variants use grid-sampled references and scalar perturbation, with invalid pixels repaired from direct high-precision orbits.
- The fractal type and exponent are baked into the generated shader source — fully unrolled, branch-free inner loops with literal coefficients. Changing either recreates the renderer ([ShaderPad](https://misery.co/shaderpad) recreation on a shared canvas is nearly free).
- While you zoom or pan, the display pass reprojects the last finished metric frame (with bilinear color blending) and fresh iteration passes are scheduled only as the view outgrows it, so interaction stays continuous even when one iteration pass takes seconds.

## Controls

### Keyboard

- `Z` / `Shift+Z`: zoom in / out
- Arrow keys: pan (`Shift` for larger steps)
- `F` / `E`: change fractal type / exponent
- `R` / `I`: change the constant's real / imaginary component (Julia and Mandala)
- `C` / `G`: change palette / color density
- `A`: toggle stripe-average coloring
- `N`, `L`, `K`, `J`: slope shading toggle, light angle, height, intensity
- `Q`: change escape radius
- `D`: change render density
- `S`: change animation speed; `Space` pauses; `Shift+Space` reverses
- `O` / `X`: return to origin / reset everything
- `Enter`: export the current frame as PNG
- `P`: toggle the profiler overlay
- `?`: show help
- Hold `Shift` with any stepped control above to reverse or shrink the step

### Mouse / Touch

- Click / tap: set the image center
- Scroll / swipe: zoom
- Multi-finger swipe: change palette and tweak parameters

## Architecture

See [the architecture and numerical contracts](docs/ARCHITECTURE.md) and [the validation report](docs/VALIDATION.md).

- `src/main.js` starts the application; `src/app.js` composes state, resources, and frame scheduling.
- `src/state/` owns camera operations and validated URL state; `src/ui/` binds input controls.
- `src/render/` owns ShaderPad resources, frame compatibility, scheduling, and fallback metric construction.
- `src/deep/referenceService.js` sends reference and repair jobs to replaceable workers.
- `src/gmpUtils.js` and `src/math/precision.js` own MPFR arithmetic and precision selection.
- The shader generators retain formula specialization and a shared metric/display contract.

## Development

```sh
git clone git@github.com:rileyjshaw/fractal.git
cd fractal
npm install
npm run dev   # local dev server
npm run check # read-only lint/format checks, unit tests, production build
npx playwright install chromium
npm run test:gpu # compile all variants, compare GPU metrics with MPFR, exercise the app
```

## Built with

- [ShaderPad](https://misery.co/shaderpad) — fullscreen WebGL2 rendering, uniforms, textures, framebuffers
- [gmp-wasm](https://github.com/Daninet/gmp-wasm) — arbitrary-precision reference orbits (MPFR)
- [tween.js](https://github.com/tweenjs/tween.js) — camera easing
- [tinykeys](https://github.com/jamiebuilds/tinykeys) — keyboard shortcuts
- [Vite](https://vitejs.dev) — dev server and bundling

## Limitations

- Variants without BLA (Burning Ship, Mandala, and exponents above 2) run every iteration scalar, so they render slower than quadratic Mandelbrot/Julia at equal depth; per-iteration cost also grows with the exponent.
- Reference search, orbit/table generation, and invalid-pixel repair run in cancellable workers. GPU iteration and float-frame readback can still stall at demanding views.
- Navigation uses decimal-string centers and adaptive MPFR precision, with a configured zoom limit near 1e400. A finite iteration budget is not proof that a pixel is mathematically interior.

## License

[GNU General Public License v3.0](/LICENSE)
