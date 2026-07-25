import tsParser from '@typescript-eslint/parser';
import { QUALITY_THRESHOLDS, SOURCE_ROOTS } from './quality-policy.mjs';

const globalIgnores = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.ai-workspace/**',
  '**/.ai-workspace-test-integration/**',
  '**/.tmp-*/**',
  '**/temp/**',
  '**/vendor/**',
  '**/generated/**',
  '**/*.generated.*',
  '**/*.min.*'
];

export const eslintPatterns = SOURCE_ROOTS.map((root) => `${root}/**/*.{js,mjs,ts,tsx}`);

export function createEslintConfig(level) {
  if (level !== 'warning' && level !== 'blocking') throw new TypeError(`Unknown ESLint quality level: ${level}`);
  const severity = level === 'warning' ? 'warn' : 'error';
  const limitKey = level === 'warning' ? 'warning' : 'blocking';
  const rules = {
    'max-lines-per-function': [
      severity,
      {
        max: QUALITY_THRESHOLDS.function[limitKey],
        skipBlankLines: true,
        skipComments: true,
        IIFEs: true
      }
    ],
    complexity: [severity, QUALITY_THRESHOLDS.complexity[limitKey]]
  };
  if (level === 'warning') {
    rules['max-len'] = [
      'warn',
      {
        code: 120,
        ignoreUrls: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreRegExpLiterals: true
      }
    ];
  }

  return [
    { ignores: globalIgnores },
    {
      files: eslintPatterns,
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } }
      },
      rules
    },
    {
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: {
        parser: tsParser,
        parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' }
      }
    },
    {
      files: ['**/*.d.ts', '**/*.d.mts', '**/*.d.cts'],
      rules: { 'max-lines-per-function': 'off' }
    }
  ];
}
