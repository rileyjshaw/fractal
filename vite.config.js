import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
	root: 'src',
	publicDir: '../public',
	build: {
		outDir: '../dist',
		emptyOutDir: true,
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
						src: 'pwa-64x64.png',
						sizes: '64x64',
						type: 'image/png',
					},
					{
						src: 'pwa-192x192.png',
						sizes: '192x192',
						type: 'image/png',
					},
					{
						src: 'pwa-512x512.png',
						sizes: '512x512',
						type: 'image/png',
					},
					{
						src: 'maskable-icon-512x512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable',
					},
				],
				theme_color: '#000',
				background_color: '#000',
				display: 'fullscreen',
			},
		}),
	],
});
