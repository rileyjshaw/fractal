import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

export default defineConfig({
	headLinkOptions: {
		basePath: '/fractal/',
	},
	preset: {
		...minimal2023Preset,
		transparent: {
			...minimal2023Preset.transparent,
			padding: 0,
		},
		maskable: {
			...minimal2023Preset.maskable,
			padding: 0,
		},
		apple: {
			...minimal2023Preset.apple,
			padding: 0,
		},
	},
	images: ['public/logo.png'],
});
