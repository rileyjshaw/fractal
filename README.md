# Fractal Explorer: GPU Edition

This project lets you zoom into, modify, and explore several fractal formulas in the browser. The standard renderer is fast and interactive, but it still hits floating point precision limits at relatively shallow zoom depths. An experimental deep zoom path is now wired in on top of ShaderPad and GMP-WASM.

This is still a curiosity project rather than a polished product. Pull requests are welcome as long as the app stays reasonably performant and fun to explore.

![Example program output](/screenshots/julia.png)

## Features

- Julia, Mandelbrot, Burning Ship, and Mandala formulas
- Keyboard, mouse, and touch controls
- Palette cycling and animated color offsets
- URL hash persistence for shareable views
- Frame export
- Experimental deep zoom infrastructure

## Current Deep Zoom Status

Deep zoom is experimental and intentionally conservative right now.

- The renderer foundation has been migrated from TWGL to ShaderPad.
- The deep zoom pipeline uses GMP-WASM to compute a reference orbit and uploads that orbit as a texture for a dedicated fragment shader.
- Deep Julia and Mandelbrot rendering now run as a two-pass pipeline: an `R32F` iteration pass plus a display/compositor pass.
- Smooth deep zoom preview uses fixed history-backed cache slots instead of rolling history reads.
- Automatic/manual deep zoom requests currently only activate the experimental deep path for validated quadratic Julia and Mandelbrot cases.
- Unsupported fractal or exponent combinations fall back to the standard renderer instead of showing a broken image.

At the moment, the supported deep zoom target is:

- Mandelbrot
- Julia
- Exponent `2`

Burning Ship, Mandala, and non-quadratic exponents stay on the standard renderer until their perturbation paths have been validated.

## Controls

### Keyboard

- `C` / `Shift+C`: change palette
- `D` / `Shift+D`: change render density
- `E` / `Shift+E`: change exponent
- `F` / `Shift+F`: change fractal type
- `G` / `Shift+G`: change color density
- `I` / `Shift+I`: change Julia imaginary component
- `Q` / `Shift+Q`: change escape radius
- `R` / `Shift+R`: change Julia real component
- `S` / `Shift+S`: change animation speed
- `T`: toggle transition smoothing, on by default
- `U` / `Shift+U`: change palette animation spacing
- `X`: reset state
- `Z` / `Shift+Z`: zoom in / out
- Arrow keys: pan
- `Space`: play / pause palette animation
- `Enter`: export the active frame

### Mouse / Touch

- Click / tap: set the image center
- Scroll / swipe: zoom
- Touch gestures: change palette and tweak parameters

## Architecture

- ShaderPad owns fullscreen rendering, uniforms, texture updates, and history-backed cache layers.
- `src/main.js` owns application state, URL persistence, inputs, and renderer lifecycle.
- `src/deepZoom.js` owns deep zoom eligibility, GMP initialization, orbit invalidation, and orbit texture payload preparation.
- `src/perturbationShader.js` owns the experimental deep iteration pass.
- `src/deepDisplayShader.js` owns the deep display/compositor pass.

## Development

```sh
git clone git@github.com:rileyjshaw/fractal.git
cd fractal
npm install
npm run dev
```

### Build

```sh
npm run build
```

## Dependencies

- `shaderpad`
- `gmp-wasm`
- `@tweenjs/tween.js`
- `tinykeys`

## Limitations

- Deep zoom is still experimental and not yet validated for every fractal or exponent combination.
- Reference-orbit computation can take noticeable time on slower devices.
- The standard renderer still loses precision at shallow deep-zoom ranges.
- Deep zoom can now go past the old `1e12` cap, but pan/center state still ultimately comes from JS doubles; true arbitrary-depth navigation needs a high-range view state.

## License

[GNU General Public License v3.0](/LICENSE)
