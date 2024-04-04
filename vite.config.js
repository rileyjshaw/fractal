import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
	root: 'src',
	build: {
		outDir: '../dist',
	},
	base: '/fractal/',
	plugins: [
		glsl(),
		VitePWA({
			workbox: {
				globPatterns: ['**/*'],
			},
			includeAssets: ['**/*'],
			registerType: 'autoUpdate',
			manifest: {
				name: 'Fractal Explorer',
				short_name: 'Fractals',
				description: 'Zoom into, modify, and explore some common fractals',
				icons: [
					{
						src: '/android-chrome-192x192.png',
						sizes: '192x192',
						type: 'image/png',
					},
					{
						src: '/android-chrome-512x512.png',
						sizes: '512x512',
						type: 'image/png',
					},
				],
				theme_color: '#c2459e',
				background_color: '#292b57',
				display: 'standalone',
				scope: '/fractal/',
			},
		}),
	],
});
