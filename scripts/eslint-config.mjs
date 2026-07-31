import tsParser from '@typescript-eslint/parser';
import { ESLINT_PROFILE_PATTERNS, QUALITY_PROFILES, SOURCE_ROOTS } from './quality-policy.mjs';

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
  const configs = [
    { ignores: globalIgnores },
    {
      files: eslintPatterns,
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } }
      },
      rules: rulesForProfile('production', level)
    }
  ];

  for (const profile of ['tooling', 'migration', 'static', 'test']) {
    configs.push({ files: ESLINT_PROFILE_PATTERNS[profile], rules: rulesForProfile(profile, level) });
  }

  configs.push(
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
  );
  return configs;
}

function rulesForProfile(profileName, level) {
  const severity = level === 'warning' ? 'warn' : 'error',
    limitKey = level === 'warning' ? 'warning' : 'blocking',
    profile = QUALITY_PROFILES[profileName],
    rules = {
      'max-lines-per-function': [
        severity,
        {
          max: profile.function[limitKey],
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true
        }
      ],
      complexity: [severity, profile.complexity[limitKey]]
    };
  if (level === 'warning') {
    rules['max-len'] = [
      'warn',
      {
        code: profile.lineLength.warning,
        ignoreUrls: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreRegExpLiterals: true
      }
    ];
  }
  return rules;
}
