// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Layer dependency rules (strict acyclic, inner to outer):
 *   domain          -> (nothing)
 *   application     -> domain
 *   presentation    -> domain
 *   infrastructure  -> domain, application, presentation
 *   composition root (src/main.ts) -> all
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/generated/**'],
  },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.mjs', '*.cjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // ---- Layer boundaries -------------------------------------------------
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/application/**', '**/infrastructure/**', '**/presentation/**'],
              message: 'domain must not depend on outer layers (dependency rule).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure/**', '**/presentation/**'],
              message:
                'application must not depend on infrastructure or presentation; depend on domain ports instead.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/presentation/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure/**'],
              message:
                'presentation must not depend on infrastructure; infrastructure wires presentation.',
            },
          ],
        },
      ],
    },
  },

  // ---- Presentation conventions ----------------------------------------
  {
    files: ['src/infrastructure/http/**/*.ts', 'src/infrastructure/logging/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // ---- Config / tests / scripts ----------------------------------------
  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts', '*.config.ts'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'no-console': 'off',
    },
  },
  {
    // Test doubles are synchronous by design; require-await is noise there.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
);
