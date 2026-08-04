/**
 * Domain core: conversation, handoff, policy, approvals.
 *
 * This package must stay free of Electron and of concrete adapters — the
 * dependency direction points inward (plan §3.2), enforced mechanically by
 * pnpm's `hoist=false` plus `no-restricted-imports` in eslint.config.mjs.
 */
export * from './conversation-service.js'
export * from './delta-buffer.js'
export * from './mentions.js'
export * from './policy/engine.js'
export * from './policy/queue.js'
export * from './policy/rules.js'
export * from './supervisor.js'
export * from './testing/fake-adapter.js'
