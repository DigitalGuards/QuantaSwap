# Frontend type safety

Production TypeScript uses strict type checking, checked indexed access, exact optional properties,
override checks, complete return paths, switch fallthrough checks, and unused local/parameter checks.
ESLint runs the type-aware `strict-type-checked` preset with assertions, explicit `any`, non-null
assertions, and all TypeScript suppression directives forbidden. Const assertions remain allowed.
Inline ESLint configuration is disabled. Numeric template interpolation and concise void callbacks
are allowed through explicit rule options.

HTTP, JSON-RPC, storage, provider announcements, and untyped library results enter as `unknown`.
Runtime predicates validate their shapes before use. `isArray` retains unknown element types.
Shape checks supplement the existing signature, semantic, deployment, and on-chain verification.
Malformed persisted records are ignored while their stored bytes remain intact. Malformed gas-policy
responses reject settlement. Existing handling of unavailable policy reads stays in place.

`npm run build` invokes formatting, lint, the ratchet check, and type checking through `prebuild`.
The repository's existing frontend CI build therefore runs these gates. `npm test` runs the offline
tests, including canonical signing vectors, calldata bytes, and malformed-input regressions.
The shared `protocol-v2-wire.ts` encoder is excluded from formatting to preserve its source bytes.

`eslint-ratchet.json` is a generated list of exact file/rule pairs and occurrence counts.
Production exceptions are confined to `no-unnecessary-condition`: existing defensive checks and
callback-mutated state are retained. Test exceptions identify existing fixture and mock debt.
Tests also permit assertions, non-null assertions, and synchronous async mocks through a test-only
override. The production assertion and unsafe-value rules have no exceptions.

`npm run lint` checks both the configured overrides and the unmodified strict configuration. Added
violations within an existing exception fail its occurrence-count check. Removed violations require
shrinking the manifest with `npm run lint:ratchet`; review the resulting diff. The generator refuses
production exceptions for any other rule. Future work can remove each remaining exception as its
associated code is cleaned up.
