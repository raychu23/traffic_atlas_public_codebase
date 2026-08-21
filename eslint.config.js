const js = require('@eslint/js');
const jsxA11y = require('eslint-plugin-jsx-a11y');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');
const globals = require('globals');

const commonRules = {
  'no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      caughtErrors: 'none',
      varsIgnorePattern: '^_',
    },
  ],
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'frontend/node_modules/**',
      'frontend/build/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  {
    files: ['*.js', 'backend/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node,
      sourceType: 'commonjs',
    },
    rules: {
      ...js.configs.recommended.rules,
      ...commonRules,
    },
  },
  {
    files: ['frontend/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.browser,
        ...globals.jest,
        global: 'readonly',
        process: 'readonly',
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      sourceType: 'module',
    },
    plugins: {
      'jsx-a11y': jsxA11y,
      react,
      'react-hooks': reactHooks,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...commonRules,
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react/react-in-jsx-scope': 'off',
    },
    settings: {
      react: { version: 'detect' },
    },
  },
  {
    files: ['backend/index.js', 'backend/storage.js'],
    rules: {
      'no-empty': 'off',
      'no-unused-vars': 'off',
    },
  },
];
