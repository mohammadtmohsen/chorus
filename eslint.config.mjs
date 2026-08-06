import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      // Generated from the Codex protocol — see plan §6.1. Linting it would
      // produce noise we cannot fix and would mask real drift in the diff.
      'packages/adapter-codex/src/generated/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* --- Global hard rules (CLAUDE.md) --- */

      // "Never use `any` type in TypeScript."
      '@typescript-eslint/no-explicit-any': 'error',

      // "Never suppress type errors with @ts-expect-error — fix the type."
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': true,
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],

      // "No console.log or debugger left in changed files." Structured logging
      // via pino is the supported path; console bypasses redaction (plan §4.4).
      'no-console': 'error',
      'no-debugger': 'error',

      /* --- Correctness --- */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  /* --- Layering enforcement (plan §3.2) ---
     The dependency direction points inward. `orchestrator` is where the
     interesting logic lives and it must stay unit-testable in milliseconds,
     which means no Electron and no concrete adapters. pnpm's `hoist=false`
     stops undeclared imports; this catches declared-but-wrong ones. */
  {
    files: ['packages/orchestrator/**/*.ts', 'packages/event-store/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'Domain packages must not depend on Electron. Wire it up in apps/desktop/src/main instead.',
            },
          ],
          patterns: [
            {
              group: ['@chorus/adapter-*'],
              message:
                'Depend on the @chorus/agent-protocol port, not a concrete adapter. See plan §4.1.',
            },
          ],
        },
      ],
    },
  },

  /* The renderer is sandboxed and has no Node. Importing it would typecheck
     and then fail at runtime, which is the worst possible failure mode. */
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'The renderer is sandboxed. Go through the typed contextBridge API on window.chorus.',
            },
          ],
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'child_process'],
              message:
                'No Node built-ins in the renderer — nodeIntegration is off by design (plan §4.4).',
            },
          ],
        },
      ],
    },
  },

  /* Tests may use console and loosen a few rules that fight fixtures. */
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  /* Config files run in Node and sit outside the type-aware project graph, so
     the typed rules have to be switched off explicitly — merged into `rules`
     rather than spread over it, or they would be clobbered and then crash. */
  /* The end-to-end drivers are plain Node scripts that talk to a built app over
     a socket. They are outside the type-aware graph for the same reason config
     files are, and they print — that is their whole output. */
  {
    files: ['apps/desktop/e2e/**/*.mjs'],
    languageOptions: {
      parserOptions: { projectService: false, project: null },
      /* Node, plus the web globals it now ships. Listed rather than pulled from
         a package, because six names are cheaper than a dependency. */
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
    },
  },

  {
    /*
     * Build scripts and config files are not part of any tsconfig — they are
     * run by node or by a bundler, never compiled — so the type-aware rules
     * have no project to resolve them against.
     */
    files: ['**/*.config.{js,mjs,ts,mts}', '**/*.setup.ts', 'apps/vscode-extension/esbuild.mjs'],
    languageOptions: { parserOptions: { projectService: false, project: null } },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
    },
  },

  prettier
)
