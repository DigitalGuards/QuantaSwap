# Frontend type safety

Production TypeScript uses strict type checking, checked indexed access, exact optional properties,
override checks, complete return paths, switch fallthrough checks, and unused local/parameter checks.
ESLint runs the type-aware `strict-type-checked` and `stylistic-type-checked` presets with assertions, explicit `any`, non-null
assertions, and all TypeScript suppression directives forbidden. Const assertions remain allowed.
Inline ESLint configuration is disabled. Numeric template interpolation and concise void callbacks
are allowed through explicit rule options.

HTTP, JSON-RPC, storage, provider announcements, and untyped library results enter as `unknown`.
Runtime predicates validate their shapes before use. `isArray` retains unknown element types.
Shape checks supplement the existing signature, semantic, deployment, and on-chain verification.
Malformed persisted records are ignored while their stored bytes remain intact. Malformed gas-policy
responses reject settlement. Existing handling of unavailable policy reads stays in place.

Every TypeScript file in the package, including tests, scripts, declarations, and Vite configuration,
uses the same hardened rules. `tsconfig.eslint.json` supplies type information and the complete
`npm run typecheck` scope. Const assertions remain allowed. Existing numeric template and concise
void-callback options remain in place.

`npm run lint` and `npm run lint:ratchet` use the shared `scripts/lint-ratchet.mjs` checker.
The package's versioned `eslint-ratchet.json` records exact file/rule pairs and occurrence counts.
The editor config applies those exceptions; the checker always scans the full strict configuration.
New pairs and increased counts fail. Resolved findings require `npm run lint:ratchet:update`, which
only reduces counts or removes pairs. Use `npm run lint:ratchet -- --base-ref origin/dev` to also
compare allowances against the integration base. CI supplies the exact PR base commit.

Bulk suppressions are ignored. Inline ESLint disables and rule overrides are rejected, and the
case-insensitive core comment guard rejects TypeScript no-check directives with extra slashes.
The checker sets `TSESTREE_SINGLE_RUN=false` before loading the parser. The initial legacy migration
requires every TypeScript file to be byte-identical to the base. Versioned bases use count ceilings.
When the base has no manifest, bootstrap verifies unchanged repository sources, sibling packages,
local dependencies, shared inputs, and dependency metadata. Only the explicit setup exceptions in
[the bootstrap policy](../docs/LINT_CENSUS.md#bootstrap-source-equality) may differ. One current scan
must exactly match the manifest's pairs and counts, in check and update modes. Source differences,
extra or missing pairs, and raised or lowered counts fail before any manifest write.

CI runs policy and ratchet integration tests, lint, the base-aware ratchet, and type checking before tests. `npm run build` also invokes
formatting, lint, and type checking through `prebuild`. `npm test` runs the offline signing, calldata,
and malformed-input regressions. The shared `protocol-v2-wire.ts` encoder remains excluded from
formatting to preserve its source bytes.

The [lint census and cleanup slices](../docs/LINT_CENSUS.md) record the setup baseline. This setup
changes enforcement and inventories existing debt; runtime and test source files remain unchanged.
