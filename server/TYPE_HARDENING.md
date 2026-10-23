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

`no-floating-promises` applies to every authored TypeScript file, including
node:test registrations, subtests, and test helpers. Existing findings are
recorded in the manifest. For cleanup, mark top-level registrations that are
intentionally not awaited with `void`; Node's test runner supports that usage
by design. Await or return subtest promises so the parent waits for completion.
See the [registration cleanup guidance](../docs/LINT_CENSUS.md#node-test-registrations-and-service-logging).

Runtime TypeScript and scripts allow `console.info`, `console.warn`, and
`console.error`. `console.log` and `console.debug` remain findings; cleanup
slices can use `console.info` to preserve stdout. Test files retain the full
`no-console` rule.

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

Before every check or update, the ratchet rejects any tracked repository path
containing a `node_modules` directory segment, at any depth and for any file
type. This covers ESLint's default recursive `node_modules` ignore and runs in
CI through the existing lint and ratchet gates. Untracked installed dependencies
remain ignored. Other generated-output exclusions apply only at package roots;
authored nested paths such as `src/build/` remain checked.

Bulk suppressions are ignored. Inline ESLint disables and rule overrides fail,
even if they would hide no finding. The case-insensitive core comment guard
rejects TypeScript no-check directives with extra slashes. The checker sets
`TSESTREE_SINGLE_RUN=false` before loading the parser.

CI runs policy and ratchet integration tests, lint, the base-aware ratchet, and typecheck before tests. The existing
`pretest` hook retains formatting, lint, and typecheck; tests also build first.
The [lint census and cleanup slices](../docs/LINT_CENSUS.md) record the baseline.
This setup preserves runtime behavior and leaves TypeScript sources unchanged.

The load harness participates in lint and the main typecheck. Its dedicated
commands remain `npm run typecheck:loadtest` and `npm run build:loadtest`.
