import { defineConfig } from '@playwright/test';
export default defineConfig({
	testDir: './tests/browser',
	timeout: 120000,
	workers: 1,
	use: {
		headless: true,
		viewport: { width: 640, height: 400 },
		deviceScaleFactor: 1,
		launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
	},
	webServer: {
		command: 'npx vite --host 127.0.0.1',
		url: 'http://127.0.0.1:5173/fractal/',
		reuseExistingServer: !process.env.CI,
	},
	outputDir: 'output/playwright',
});
