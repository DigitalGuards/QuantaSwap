TypeScript checks
=================

All eight compiler checks are enabled: `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, `noUnusedLocals`, and `noUnusedParameters`.

The package uses its own ESLint flat config with `strictTypeChecked` and error
rules for assertions, explicit `any`, non-null assertions, and all TypeScript
comment directives. Const assertions remain supported. Production code uses
runtime predicates for unknown input; direct `Array.isArray` calls are confined
to `src/guards.ts`. Inline ESLint configuration is disabled.

`eslint-ratchet.json` is the generated inventory of existing diagnostics, keyed
by exact source file and rule. The flat config applies those pairs for editor
use. `npm run lint` checks the full strict configuration and enforces each saved
count as a ceiling, including within existing files. New files and rule pairs
start at zero. The four assertion and suppression rules cannot enter the
ratchet. Reduced counts fail until `npm run lint:prune` removes the resolved
debt; that command also refuses increases. Review the JSON diff when pruning.

Tests have scoped exceptions for assertions, non-null assertions, native array
checks, and the promises returned by Node test registration. The explicit-any
and TypeScript-comment bans continue to apply. All other exceptions appear as
exact pairs in the ratchet inventory.

Existing CI runs `npm test`. Its `pretest` hook now runs `format:check`, `lint`,
and `typecheck`; the test script also builds before running the test suite.
Run those four checks and `npm run build` before committing. Runtime dependencies
and valid signing payloads retain their existing behavior. Malformed RPC,
response, and persisted-state inputs are rejected or dropped at their guards.

`src/taker-test-harness.ts`, `src/taker-survival-child.ts`, and the two named
proof fixture helpers use the test scope. `src/htlc.ts` uses the production
signing rules with no library cast exception.
