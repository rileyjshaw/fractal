import js from '@eslint/js';
import globals from 'globals';
export default [
	{ ignores: ['dist/**', 'node_modules/**', 'reference/**', 'output/**'] },
	js.configs.recommended,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.worker } },
		rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] },
	},
];
