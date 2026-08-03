/**
 * Domain core: conversation, handoff, policy, approvals.
 *
 * This package must stay free of Electron and of concrete adapters — the
 * dependency direction points inward (plan §3.2), and that is enforced
 * mechanically by pnpm's `hoist=false` plus the `no-restricted-imports` rule
 * in eslint.config.mjs.
 *
 * M1 lands the conversation aggregate and reducers here.
 */
export {}
