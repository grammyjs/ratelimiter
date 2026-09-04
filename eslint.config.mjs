import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

const typescriptSourceFiles = ['mod.ts', 'storages.ts', 'src/**/*.ts'];
const typescriptSupportFiles = ['examples/**/*.ts', 'tests/**/*.ts'];
const nodeFiles = ['eslint.config.mjs', 'examples/**/*.mjs', 'tests/**/*.mjs'];

const typescriptRelaxedRules = {
	'no-unused-vars': 'off',
	'@typescript-eslint/no-empty-function': 'off',
	'@typescript-eslint/no-explicit-any': 'off',
	'@typescript-eslint/no-unnecessary-type-assertion': 'off',
	'@typescript-eslint/prefer-optional-chain': 'off',
	'@typescript-eslint/no-unused-vars': [
		'error',
		{
			argsIgnorePattern: '^_',
			caughtErrorsIgnorePattern: '^_',
			varsIgnorePattern: '^_',
		},
	],
};

export default defineConfig(
	{
		ignores: ['dist/**', 'node_modules/**'],
	},
	{
		name: 'ratelimiter/typescript-source',
		files: typescriptSourceFiles,
		extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			...typescriptRelaxedRules,
			'@typescript-eslint/consistent-type-imports': [
				'error',
				{
					fixStyle: 'separate-type-imports',
					prefer: 'type-imports',
				},
			],
		},
	},
	{
		name: 'ratelimiter/typescript-support',
		files: typescriptSupportFiles,
		extends: [js.configs.recommended, tseslint.configs.recommended],
		rules: typescriptRelaxedRules,
	},
	{
		name: 'ratelimiter/node',
		files: nodeFiles,
		extends: [js.configs.recommended],
		languageOptions: {
			globals: globals.nodeBuiltin,
		},
	},
	{
		linterOptions: {
			reportUnusedDisableDirectives: 'error',
			reportUnusedInlineConfigs: 'error',
		},
	},
);
