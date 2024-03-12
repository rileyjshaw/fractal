import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';

export default defineConfig({
	root: 'src',
	build: {
		outDir: '../dist',
	},
	base: '/mandelbrot/',
	plugins: [glsl()],
});
