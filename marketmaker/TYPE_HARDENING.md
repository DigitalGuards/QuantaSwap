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

The node:test promise exemption applies only to compiled, non-hidden top-level
`src/*.test.ts` files selected by `node --test dist/*.test.js` and these
exact helper paths:
`src/protocol-v2-test-helper.ts`, `src/taker-test-harness.ts`, and
`src/taker-survival-child.ts`. The shared
`scripts/lint-ratchet-node-tests.mjs` scope reader supplies exact file paths to
ESLint. It checks the complete `package.json` test command, requires `build` to
remain `tsc`, and uses the installed TypeScript compiler to read `tsconfig.json`,
including inherited settings and file exclusions. JavaScript emission must map
`src` to `dist`. A command or output mapping change fails until the scope
contract is reviewed and updated.

The helper check requires each helper and its named loader to be compiled, with
the loader in the executed test set. It checks value imports from
`protocol-signing.test.ts` and `taker-e2e.test.ts`, plus the child-script URL in
`taker-survival.test.ts`. The survival test launches and checks that child.
`src/legacy-v1-test-helper.ts` has no test importer and receives no node:test
promise exemption. Its existing console and native-array policies remain.

Every lint and ratchet check or update also inventories all package `*.test.ts`
files recursively, including hidden and Git-ignored paths. Only `node_modules`
and `.git` directories are skipped. Any test outside the executed set fails
with its path before manifest comparisons or writes. This includes nested,
compiler-excluded, and out-of-source tests. The existing CI lint and ratchet
steps run this guard. The current inventory has 23 executed test files and no
unrun test files; test discovery remains unchanged.

The exemption uses typescript-eslint's documented
[`allowForKnownSafeCalls`](https://typescript-eslint.io/rules/no-floating-promises/#allowforknownsafecalls)
package specifier with `from: "package"`, `package: "node:test"`, and names
`test`, `describe`, `it`, `suite`, `skip`, `only`, and `todo`. It allows
runner-owned registrations and their `.skip`, `.only`, and `.todo` members to
float. Production code keeps `no-floating-promises` without this exemption;
ordinary promises in tests remain subject to that rule.

This exemption is type-based. A test author can deliberately bypass the promise
check by aliasing node:test functions, borrowing their types, or mutating members
such as `test.skip`. It can also cover `TestContext.test` through its shared
registration type. Authors must await, return, or join subtests so their parent
waits for them. Node's test runner fails the run on unhandled rejections and
cancelled subtests, including children returned from unrelated callbacks that
the parent does not join. CI runs these tests through `npm test`. See Node's
[test runner documentation](https://nodejs.org/api/test.html#subtests) for the
runtime behavior.

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
