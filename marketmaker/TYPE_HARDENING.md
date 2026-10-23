# TypeScript checks

All eight compiler checks remain enabled: `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, `noUnusedLocals`, and `noUnusedParameters`.

Every TypeScript file in the package, including tests, scripts, and declarations,
uses `strictTypeChecked`, `stylisticTypeChecked`, and the shared hardened rules.
Assertions, explicit `any`, non-null assertions, floating promises, and TypeScript
suppression directives are errors. Const assertions remain allowed. Type imports,
numeric template interpolation, double-assertion guards, and console rules follow
the wallet policy. Existing unused-binding options remain in place. Production
native array checks stay confined to `src/guards.ts`; the existing fixture scope
retains its native array checks. Tests have the same typed rule set as app code.

Node test registrations use the package-qualified `allowForKnownSafeCalls`
exception for `node:test` (`test`, `describe`, `it`, `suite`, and their
`skip`, `only`, and `todo` variants). The `node-test/direct-registrations` rule
requires direct calls on imported bindings and rejects value aliases and type
references. The `node-test/no-floating-subtests` rule requires a direct
`TestContext.test` call with an awaited or returned result, including calls joined
by the built-in `Promise.all` or `Promise.allSettled`. Method extraction through
properties, arrays, binding, arguments, assignments, and destructuring fails.
Other floating promises remain findings.

Runtime TypeScript and scripts allow `console.info`, `console.warn`, and
`console.error`. `console.log` and `console.debug` remain findings; cleanup
slices can use `console.info` to preserve stdout. Test files and the four named
test helpers in the ESLint config retain the full `no-console` rule.

`tsconfig.eslint.json` covers the entire package and supplies both ESLint's type
information and `npm run typecheck`. Runtime builds still use `tsconfig.json`.

`npm run lint` and `npm run lint:ratchet` use the shared
`scripts/lint-ratchet.mjs` checker. The package's versioned
`eslint-ratchet.json` records exact file/rule pairs with occurrence counts.
Editor overrides use these pairs; the checker scans the full strict config.
New pairs and increased counts fail. Resolved findings require
`npm run lint:ratchet:update`, which only reduces counts or removes pairs.
`npm run lint:ratchet -- --base-ref origin/dev --integration-ref origin/dev`
also compares allowances against Git. CI supplies the exact PR base commit and
`origin/dev` as the integration reference. A versioned base enforces its saved
pair and count ceilings. A legacy or missing base manifest uses the versioned
integration manifest when available, permitting dev-to-main promotion. When
neither reference has a versioned manifest, bootstrap verifies unchanged
repository sources, sibling packages,
local dependencies, shared inputs, and dependency metadata. Only the explicit setup
exceptions in [the bootstrap policy](../docs/LINT_CENSUS.md#bootstrap-source-equality)
may differ. One current scan must exactly match the manifest's pairs and counts,
in check and update modes. Source differences, extra or missing pairs, and raised
or lowered counts fail before any manifest write.

Bulk suppressions are ignored. Inline ESLint disables and rule overrides fail,
even if they would hide no finding. The case-insensitive core comment guard
rejects TypeScript no-check directives with extra slashes. The checker sets
`TSESTREE_SINGLE_RUN=false` before loading the parser.

CI runs policy and ratchet integration tests, lint, the base-aware ratchet, and typecheck before tests. The existing
`pretest` hook retains formatting, lint, and typecheck; tests also build first.
The [lint census and cleanup slices](../docs/LINT_CENSUS.md) record the baseline.
This setup preserves runtime behavior and leaves TypeScript sources unchanged.
