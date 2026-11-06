import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/build/**/*',
      '!apps/extension/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      // Spike harnesses kept beside their plan as evidence. They drive a live
      // agent and are not part of any build, so they are outside the project
      // service the type-aware rules need.
      'docs/plans/**',
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

  /* A renderer *test* is not the renderer.
     The rule above exists because an import that typechecks and then fails in a
     sandboxed window is the worst possible failure mode. A `*.test.ts` has no
     such window: vitest runs it in Node and it is never in the bundle. The one
     thing that needs this is `theme.test.ts`, which reads `styles.css` off disk
     so the contrast floors are checked against the sheet the app actually ships
     rather than against a copy of its values kept in a test — which is exactly
     how a palette drifts below AA with a passing suite. */
  {
    files: ['apps/desktop/src/renderer/**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-imports': 'off' },
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
    files: ['apps/desktop/e2e/**/*.mjs', 'apps/extension/e2e/**/*.mjs'],
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
        Buffer: 'readonly',
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
    files: [
      '**/*.config.{js,mjs,ts,mts}',
      '**/*.setup.ts',
      'apps/vscode-extension/esbuild.mjs',
      'apps/engine/*.mjs',
      'apps/extension/*.mjs',
      'apps/vscode-extension/package.mjs',
      'apps/vscode-extension/zip.mjs',
      /*
       * The workbench fixture, and it belongs here for a stronger reason than
       * the build scripts above: it is deliberately plain CommonJS with no
       * TypeScript, no bundler and no dependencies, because every layer between
       * its source and the extension host is another suspect when the proof
       * fails. Adding a tsconfig to satisfy the linter would undo the thing it
       * exists to demonstrate.
       *
       * Until it was listed, both files failed to parse at all — "not found by
       * the project service" — which is two errors that look like lint findings
       * and are actually the linter never having read the file.
       */
      'apps/workbench-fixture/extension.js',
      'apps/workbench-fixture/package.mjs',
      'scripts/**/*.mjs',
    ],
    languageOptions: {
      parserOptions: { projectService: false, project: null },
      /* Node build scripts. Listed rather than pulled from a globals package,
         for the same reason the e2e block lists its own. */
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        /* The fixture is CommonJS — the only file here that is. */
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        /* Node has had `fetch` global since 18 and this repo's engines are well
           past that; `workbench-manifest.mjs` reads the VSCodium release API
           with it. Listed here rather than switched to a globals package for the
           reason the block above already gives. */
        fetch: 'readonly',
      },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
    },
  },

  {
    /*
     * The fixture extension, once it was finally being parsed, turned out to
     * break two rules by *being what it is* rather than by needing a fix.
     *
     * `require` is not a style choice here: a VS Code extension host loads
     * `main` as CommonJS, and the fixture has no build step to convert anything
     * — which is the property that makes it a usable proof, since a failure has
     * to name one suspect and a bundler is another one.
     *
     * `deactivate` is empty because the extension holds nothing to release. The
     * VS Code API asks for the export, so deleting it to satisfy the linter
     * would change the contract to quiet a warning about a body.
     */
    files: ['apps/workbench-fixture/extension.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },

  prettier
)
