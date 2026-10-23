# Lint setup census

Baseline: QuantaSwap `798214a0287b2c6d7193e0e2c57a5b78b57e2091` (`origin/dev` at setup).

Counts use the locked dependencies: ESLint 10.12.0, typescript-eslint 8.71.1, and TypeScript 5.8.3. No dependencies or TypeScript sources changed. Counts are diagnostic occurrences, so several findings can refer to one source expression. The versioned package manifests are the executable source of truth; this document records the setup snapshot.

## Enforcement

Every package uses strict-type-checked and stylistic-type-checked on all authored `.ts`, `.tsx`, `.mts`, and `.cts` files, including tests and scripts. Generated output and dependencies are excluded. Shared hardening lives in `scripts/eslint-policy.mjs`; package configs retain their existing extra options. Assertions, explicit any, non-null assertions, floating promises, type imports, template expressions, console calls, and TypeScript comment directives follow the hardened wallet policy. Const assertions remain legal. Existing native-array fixture exceptions remain scoped in the Node packages.

The only checker is `scripts/lint-ratchet.mjs`, called by each package. `npm run lint` and `npm run lint:ratchet` check exact file/rule counts. `npm run lint:ratchet:update` can only lower counts or remove resolved pairs. Add `-- --base-ref origin/dev --integration-ref origin/dev` to compare the manifest with Git references. CI supplies the PR base SHA, the previous push SHA, or the current SHA for manual/tag runs, plus `origin/dev` as the integration reference. A version 1 base manifest is authoritative. If the base has a legacy or missing manifest, the checker uses a version 1 integration manifest in normal mode. This permits the first dev-to-main promotion after dev adopts the census, including existing differences between the branches. When neither reference has a version 1 manifest, bootstrap requires repository-wide source equality against the base and an exact current manifest as described below. The integration reference defaults to `origin/dev` for base-aware checks. Historical configuration is never executed and invalid reference manifests fail.

The checker sets `TSESTREE_SINGLE_RUN=false` before loading ESLint, ignores bulk suppressions, and rejects inline ESLint configuration in both TypeScript and package JavaScript tooling. Suppression guards cannot be ratcheted. The core no-warning-comments rule uses terms `["@ts-nocheck"]`, location `start`, and decoration `["/"]` to catch mixed-case directives and extra slashes. Guard and ratchet integration tests run in each package workflow. The integration suite uses complete isolated repository copies and temporary Git objects to test missing, legacy, and versioned base manifests. Every package exercises shared and sibling source changes with allowances, new `any` with an allowance, raised and lowered counts, extra and missing pairs, rejected updates without writes, exact bootstrap success, and saved-base growth and shrink behavior. The policy suite also checks repeated typed parsing across sources, tests, and scripts.

The five package workflows retain their job IDs and names. Each package job, including the orderbook browser job and both release jobs, installs dependencies and runs policy and integration tests, lint, the base-aware ratchet, and typecheck before application tests. Shared policy and ratchet changes trigger all three CI workflows. Changes to the Node test companion trigger both service CI workflows. All three CI workflows cover pushes to dev and main and pass both ratchet references for PRs and pushes.

### Bootstrap source equality

Legacy and missing manifests both require every repository source and input to retain its base bytes when neither reference has adopted version 1. This deliberately includes all sibling packages and local dependencies, every file in each lint scope, shared `config/` inputs, declarations, tests, package metadata, and lockfiles. The checker compares raw worktree bytes with Git blob IDs, without Git clean filters or line-ending normalization. It checks base paths plus tracked and nonignored untracked paths, detecting additions, deletions, renames, and symlink replacements. It also walks authored JavaScript and TypeScript files, including Git-ignored sources, because ESLint does not honor `.gitignore`. Generated output, installed dependencies, and ignored local state are outside that inventory.

The complete bootstrap exception list is:

- The three packages' `eslint.config.js` or `eslint.config.mjs`, `eslint-ratchet.json`, `tsconfig.json`, and `tsconfig.eslint.json`. The main tsconfigs are inherited by the lint projects.
- `scripts/eslint-policy.mjs`, `scripts/eslint-node-test.mjs`, `scripts/lint-ratchet.mjs`, `scripts/lint-ratchet-lib.mjs`, `scripts/lint-ratchet.test.mjs`, and `scripts/lint-ratchet.integration.test.mjs`.
- The replaced runners `frontend/scripts/check-lint-ratchet.mjs`, `server/lint.mjs`, and `marketmaker/lint.mjs`.
- The `scripts` object in an existing `package.json`. Every other parsed field must remain equal, including dependency declarations, exports, type entry points, and package identity. JSON formatting and key order may change.
- `.github/workflows/*.yml` and `.github/workflows/*.yaml`.
- Markdown documentation (`*.md`) outside `config/`.

Any other source or input difference fails with `Bootstrap setup PR must not change sources` and the affected path. Repository-wide equality avoids maintaining an incomplete import or local-dependency graph. No base export or second lint scan occurs.

After equality passes, one scan of the checked package must produce exactly the manifest's file/rule pairs and counts. Extra pairs, missing pairs, higher counts, and lower counts all fail. Both check and update enforce equality before writing; failed updates preserve the manifest. Because sources match the base, this scan measures the base sources under the new policy. A legacy manifest receives the same freeze and exact-count checks as a missing manifest. Versioned reference ceilings and ordinary debt-reducing updates retain their existing behavior.

### Node test registrations and service logging

Server and marketmaker use `allowForKnownSafeCalls` with `from: "package"`, `package: "node:test"`, and names `test`, `describe`, `it`, `suite`, `skip`, `only`, and `todo`. The allowance covers conventional TypeScript test paths (`*.test.*`, `*.spec.*`, and `test`, `tests`, or `__tests__` directories). Marketmaker also includes its four existing named test helpers. The `node-test/direct-registrations` rule confines the allowance to direct calls on the imported registration bindings, including renamed, default, and namespace imports and their skip, only, and todo members. Extracted registration values and type references such as `typeof test.skip` fail, so an ordinary promise-returning function cannot borrow the exempt type. Unrelated functions with these names keep the promise rule.

`scripts/eslint-node-test.mjs` uses each package's installed TypeScript to identify registration and `TestContext.test` declarations. Both companion rules remain errors throughout typed code. Every reference to the context's test method must be a direct call whose result is awaited or returned. Method extraction through bind, object properties, arrays, arguments, assignments, and destructuring fails at the reference. Direct, computed, and optional calls pass when awaited or returned, including subtests joined by the awaited or returned built-in `Promise.all` or `Promise.allSettled`. Unhandled calls, stored results, and explicit `void` fail. Every other floating promise remains subject to the original rule. The policy tests cover these forms, and integration tests reproduce the rejected-promise and cancelled-child runtime failures while asserting that lint and the ratchet reject both.

Runtime TypeScript and scripts in the two services allow only `console.info`, `console.warn`, and `console.error`. `console.log` and `console.debug` remain findings. Later cleanup slices can change those calls to `console.info` to preserve stdout. Tests and the named marketmaker test helpers retain the existing full `no-console` rule. Frontend configuration and its regenerated manifest are unchanged. No application finding was fixed in this policy update.

## Totals

| Package     | TypeScript files scanned | Files with findings | Findings | File/rule pairs | Proposed slices |
| ----------- | -----------------------: | ------------------: | -------: | --------------: | --------------: |
| frontend    |                       97 |                  37 |      363 |              86 |               9 |
| server      |                       52 |                  30 |      510 |              79 |              12 |
| marketmaker |                       56 |                  39 |      670 |              88 |              15 |

The policy removes 746 runner-owned registration reports and 37 permitted service logging reports. The census decreases from 2,326 to 1,543 findings. The revised plan contains 36 slices, each with 20 to 60 findings.

## Findings by rule

Rule names beginning with `@typescript-eslint/` are shortened in this table. Zero means the rule has no current debt in that package. The subtest rule is enabled only in server and marketmaker.

| Rule                                | Frontend | Server | Marketmaker |
| ----------------------------------- | -------: | -----: | ----------: |
| `dot-notation`                      |       60 |    324 |         385 |
| `no-floating-promises`              |        0 |      0 |           0 |
| `consistent-type-assertions`        |       73 |     43 |          94 |
| `require-await`                     |       83 |     21 |          20 |
| `no-console`                        |        0 |     11 |          60 |
| `no-unnecessary-condition`          |       30 |     27 |          45 |
| `no-non-null-assertion`             |       33 |     16 |          26 |
| `prefer-optional-chain`             |       31 |      6 |          12 |
| `no-base-to-string`                 |       10 |     12 |           3 |
| `array-type`                        |        4 |     17 |           3 |
| `no-restricted-syntax`              |       13 |      2 |           6 |
| `non-nullable-type-assertion-style` |        8 |      0 |           0 |
| `no-useless-assignment`             |        0 |      8 |           0 |
| `no-unsafe-assignment`              |        7 |      0 |           0 |
| `consistent-type-definitions`       |        3 |      1 |           2 |
| `no-empty-function`                 |        0 |      4 |           2 |
| `prefer-includes`                   |        0 |      5 |           0 |
| `preserve-caught-error`             |        0 |      3 |           2 |
| `no-unsafe-member-access`           |        2 |      0 |           2 |
| `prefer-promise-reject-errors`      |        0 |      4 |           0 |
| `consistent-type-imports`           |        0 |      2 |           1 |
| `prefer-nullish-coalescing`         |        2 |      1 |           0 |
| `no-dynamic-delete`                 |        0 |      0 |           2 |
| `no-invalid-void-type`              |        0 |      2 |           0 |
| `no-unsafe-return`                  |        0 |      0 |           2 |
| `only-throw-error`                  |        0 |      0 |           2 |
| `no-this-alias`                     |        1 |      0 |           0 |
| `no-unsafe-argument`                |        1 |      0 |           0 |
| `prefer-function-type`              |        0 |      0 |           1 |
| `no-constant-condition`             |        1 |      0 |           0 |
| `no-control-regex`                  |        1 |      0 |           0 |
| `no-useless-escape`                 |        0 |      1 |           0 |
| `node-test/no-floating-subtests`    |        0 |      0 |           0 |

## frontend: findings by file

Paths are relative to the package. All nonzero files are listed, largest first.

| File                                          | Findings |
| --------------------------------------------- | -------: |
| `src/lib/orderbookClient.ts`                  |       46 |
| `src/lib/orderSigning.test.ts`                |       39 |
| `src/lib/orderbookClient.test.ts`             |       37 |
| `src/lib/legSender.test.ts`                   |       29 |
| `src/lib/mirrorBook.test.ts`                  |       25 |
| `src/lib/payoutCredits.test.ts`               |       19 |
| `src/lib/swapMachine.ts`                      |       19 |
| `src/lib/relayReset.test.ts`                  |       15 |
| `src/hooks/useEthWallet.test.tsx`             |       13 |
| `src/lib/orderSigning.ts`                     |       13 |
| `src/hooks/useQrlWallet.test.tsx`             |       12 |
| `src/lib/htlc.v3.test.ts`                     |       11 |
| `src/lib/mirrorBook.ts`                       |       11 |
| `src/lib/signedOrderRecovery.test.ts`         |        9 |
| `src/components/signedOrderFlow.test.ts`      |        7 |
| `src/components/PostOrderCard.tsx`            |        6 |
| `src/config.ts`                               |        6 |
| `src/lib/htlc.test.ts`                        |        6 |
| `src/components/SwapFlow.credits.test.tsx`    |        5 |
| `src/lib/payoutCreditedTopics.test.ts`        |        4 |
| `src/components/MyOrderCard.tsx`              |        3 |
| `src/hooks/useAnnounceReconcile.test.ts`      |        3 |
| `src/lib/orderbook.ts`                        |        3 |
| `src/lib/walletConnect.test.ts`               |        3 |
| `src/components/DeferredPayoutPanel.test.tsx` |        2 |
| `src/components/SwapFlow.tsx`                 |        2 |
| `src/components/signedOrderFlow.ts`           |        2 |
| `src/hooks/useAnnounceReconcile.ts`           |        2 |
| `src/lib/orderbook.test.ts`                   |        2 |
| `src/pages/SwapStatusPage.tsx`                |        2 |
| `src/components/OrderBookPanel.tsx`           |        1 |
| `src/components/PairingModal.test.tsx`        |        1 |
| `src/hooks/useQrlWallet.ts`                   |        1 |
| `src/lib/protocol-v2-wire.ts`                 |        1 |
| `src/lib/relayReset.ts`                       |        1 |
| `src/pages/SwapPage.tsx`                      |        1 |
| `vite.config.ts`                              |        1 |

## server: findings by file

Paths are relative to the package. All nonzero files are listed, largest first.

| File                            | Findings |
| ------------------------------- | -------: |
| `src/store.ts`                  |      126 |
| `src/peer-sync.test.ts`         |       60 |
| `src/order-signing.ts`          |       44 |
| `src/peer-sync.ts`              |       32 |
| `src/loadtest/scenarios.ts`     |       28 |
| `src/loadtest/consistency.ts`   |       26 |
| `src/federation.ts`             |       25 |
| `src/loadtest/main.ts`          |       23 |
| `src/inflight-gate.test.ts`     |       22 |
| `src/server.ts`                 |       21 |
| `src/store-protocol.test.ts`    |       20 |
| `src/federation.test.ts`        |       18 |
| `src/lease-integration.test.ts` |       11 |
| `src/protocol-v2-wire.test.ts`  |       11 |
| `src/order-signing.test.ts`     |        9 |
| `src/store.test.ts`             |        8 |
| `src/config.ts`                 |        6 |
| `src/process-lease.ts`          |        3 |
| `src/loadtest/probe-worker.ts`  |        2 |
| `src/loadtest/reasons.ts`       |        2 |
| `src/peer-transport.test.ts`    |        2 |
| `src/peer-transport.ts`         |        2 |
| `src/process-lease.test.ts`     |        2 |
| `src/admission.test.ts`         |        1 |
| `src/cors.test.ts`              |        1 |
| `src/federation-reset.test.ts`  |        1 |
| `src/guards.ts`                 |        1 |
| `src/healthcheck.ts`            |        1 |
| `src/loadtest/proofs.ts`        |        1 |
| `src/protocol-v2-wire.ts`       |        1 |

## marketmaker: findings by file

Paths are relative to the package. All nonzero files are listed, largest first.

| File                             | Findings |
| -------------------------------- | -------: |
| `src/state.ts`                   |       93 |
| `src/orderbook.ts`               |       90 |
| `src/taker-proofs.ts`            |       75 |
| `src/taker-state.ts`             |       75 |
| `src/taker-test-harness.ts`      |       46 |
| `src/state.test.ts`              |       45 |
| `src/taker-cli.ts`               |       40 |
| `src/protocol-signing.ts`        |       25 |
| `src/taker-state.test.ts`        |       22 |
| `src/orderbook.test.ts`          |       15 |
| `src/chains.test.ts`             |       12 |
| `src/htlc.ts`                    |       12 |
| `src/protocol-signing.test.ts`   |       11 |
| `src/protocol-v2-wire.test.ts`   |       11 |
| `src/taker-e2e.test.ts`          |       11 |
| `src/credits-cli.ts`             |       10 |
| `src/htlc.test.ts`               |       10 |
| `src/index.ts`                   |        7 |
| `src/init-keys.ts`               |        6 |
| `src/price.ts`                   |        6 |
| `src/taker.ts`                   |        6 |
| `src/qrl-web3-compat.test.ts`    |        5 |
| `src/taker-survival-child.ts`    |        5 |
| `src/admission.test.ts`          |        4 |
| `src/drain.test.ts`              |        4 |
| `src/qrvmHtlc.test.ts`           |        3 |
| `src/taker-orderbook.ts`         |        3 |
| `src/config.test.ts`             |        2 |
| `src/legacy-v1-test-helper.ts`   |        2 |
| `src/policy.test.ts`             |        2 |
| `src/protocol-v2-test-helper.ts` |        2 |
| `src/taker-policy.ts`            |        2 |
| `src/taker-proofs.test.ts`       |        2 |
| `src/config.ts`                  |        1 |
| `src/deployment.ts`              |        1 |
| `src/guards.ts`                  |        1 |
| `src/health.test.ts`             |        1 |
| `src/protocol-v2-wire.ts`        |        1 |
| `src/taker-policy.test.ts`       |        1 |

## Floating-promise verification

There are zero remaining `no-floating-promises` findings and zero `node-test/no-floating-subtests` findings in both services. Five real remaining findings per package therefore do not exist in this snapshot.

An independent scan with the safe-call allowance removed reproduced all 240 server and 506 marketmaker reports. Each call's resolved TypeScript signature was checked against the `node:test` module declaration: all 746 matched. Server has 25 `describe` and 215 `it` calls; marketmaker has 72 `describe` and 434 `it` calls. The regression suite also checks that ordinary rejected promises and unrelated functions named `test`, `describe`, or `skip` remain findings, and that unhandled subtests remain findings.

These five examples per package are verified registrations removed by the policy, provided as audit samples. They are resolved policy reports, with no source edits:

| Package     | File and line                          | Resolved call       |
| ----------- | -------------------------------------- | ------------------- |
| server      | `server/src/admission.test.ts:32`      | `node:test.it(...)` |
| server      | `server/src/client-ip.test.ts:6`       | `node:test.it(...)` |
| server      | `server/src/federation.test.ts:79`     | `node:test.it(...)` |
| server      | `server/src/peer-sync.test.ts:50`      | `node:test.it(...)` |
| server      | `server/src/store.test.ts:38`          | `node:test.it(...)` |
| marketmaker | `marketmaker/src/admission.test.ts:11` | `node:test.it(...)` |
| marketmaker | `marketmaker/src/chains.test.ts:189`   | `node:test.it(...)` |
| marketmaker | `marketmaker/src/htlc.test.ts:88`      | `node:test.it(...)` |
| marketmaker | `marketmaker/src/policy.test.ts:164`   | `node:test.it(...)` |
| marketmaker | `marketmaker/src/state.test.ts:249`    | `node:test.it(...)` |

## Proposed cleanup slices

Each slice must preserve runtime behavior, shrink only its manifest allowances, and pass the full package gates. This policy update implements no cleanup slice. Counts partition every remaining finding exactly once; line ranges refer to this snapshot and identify diagnostic locations within large files.

Replace unsafe fixture casts with typed builders or guarded inputs. Review optional/nullish rewrites for behavioral equivalence. Runtime logging cleanup uses `console.info` for `console.log` and `console.debug`, preserving stdout; tests retain their existing console policy. Keep deterministic wire vectors aligned whenever a later slice changes the shared protocol encoder. Node registration findings need no cleanup under the configured policy.

### frontend

| Slice                                       | Scope                                                                                                                                                                                                                                                                            | Findings |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------: |
| 1. Orderbook implementation and wire        | `src/lib/orderbookClient.ts` (46); `src/lib/orderbook.ts` (3); `src/lib/orderbook.test.ts` (2); `src/lib/protocol-v2-wire.ts` (1)                                                                                                                                                |       52 |
| 2. Signing and order-flow fixtures          | `src/lib/orderSigning.test.ts` (39); `src/components/signedOrderFlow.test.ts` (7)                                                                                                                                                                                                |       46 |
| 3. Client and recovery fixtures             | `src/lib/orderbookClient.test.ts` (37); `src/lib/signedOrderRecovery.test.ts` (9)                                                                                                                                                                                                |       46 |
| 4. Leg transport and HTLC fixtures          | `src/lib/legSender.test.ts` (29); `src/lib/htlc.v3.test.ts` (11); `src/lib/htlc.test.ts` (6)                                                                                                                                                                                     |       46 |
| 5. Mirror, reset and signing implementation | `src/lib/mirrorBook.ts` (11); `src/lib/mirrorBook.test.ts` (25); `src/lib/relayReset.ts` (1); `src/lib/orderSigning.ts` (13)                                                                                                                                                     |       50 |
| 6. Wallet and reset fixtures                | `src/hooks/useEthWallet.test.tsx` (13); `src/hooks/useQrlWallet.test.tsx` (12); `src/lib/relayReset.test.ts` (15); `src/lib/walletConnect.test.ts` (3); `src/hooks/useQrlWallet.ts` (1)                                                                                          |       44 |
| 7. Payout fixtures                          | `src/lib/payoutCredits.test.ts` (19); `src/lib/payoutCreditedTopics.test.ts` (4); `src/components/SwapFlow.credits.test.tsx` (5); `src/components/DeferredPayoutPanel.test.tsx` (2)                                                                                              |       30 |
| 8. Swap state and reconciliation            | `src/lib/swapMachine.ts` (19); `src/hooks/useAnnounceReconcile.test.ts` (3); `src/hooks/useAnnounceReconcile.ts` (2); `src/components/PairingModal.test.tsx` (1); `src/pages/SwapPage.tsx` (1)                                                                                   |       26 |
| 9. UI and configuration tail                | `src/components/PostOrderCard.tsx` (6); `src/config.ts` (6); `src/components/MyOrderCard.tsx` (3); `src/components/SwapFlow.tsx` (2); `src/components/signedOrderFlow.ts` (2); `src/pages/SwapStatusPage.tsx` (2); `src/components/OrderBookPanel.tsx` (1); `vite.config.ts` (1) |       23 |

### server

| Slice                                      | Scope                                                                                                                                        | Findings |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------: |
| 1. store.ts part 1                         | `src/store.ts` lines 416-925                                                                                                                 |       42 |
| 2. store.ts part 2                         | `src/store.ts` lines 926-1980                                                                                                                |       42 |
| 3. store.ts part 3                         | `src/store.ts` lines 1981-3363                                                                                                               |       42 |
| 4. Peer sync fixtures                      | `src/peer-sync.test.ts` (60)                                                                                                                 |       60 |
| 5. Order signing and fixtures              | `src/order-signing.ts` (44); `src/order-signing.test.ts` (9)                                                                                 |       53 |
| 6. Peer sync and transport                 | `src/peer-sync.ts` (32); `src/peer-transport.ts` (2); `src/peer-transport.test.ts` (2)                                                       |       36 |
| 7. Federation and reset                    | `src/federation.ts` (25); `src/federation.test.ts` (18); `src/federation-reset.test.ts` (1)                                                  |       44 |
| 8. Load scenarios and consistency          | `src/loadtest/scenarios.ts` (28); `src/loadtest/consistency.ts` (26)                                                                         |       54 |
| 9. Load entry and helpers                  | `src/loadtest/main.ts` (23); `src/loadtest/probe-worker.ts` (2); `src/loadtest/reasons.ts` (2); `src/loadtest/proofs.ts` (1)                 |       28 |
| 10. Store and wire fixtures                | `src/store-protocol.test.ts` (20); `src/store.test.ts` (8); `src/protocol-v2-wire.test.ts` (11); `src/protocol-v2-wire.ts` (1)               |       40 |
| 11. Admission and lease fixtures           | `src/inflight-gate.test.ts` (22); `src/lease-integration.test.ts` (11); `src/process-lease.test.ts` (2); `src/admission.test.ts` (1)         |       36 |
| 12. Server, configuration and process tail | `src/server.ts` (21); `src/config.ts` (6); `src/process-lease.ts` (3); `src/guards.ts` (1); `src/healthcheck.ts` (1); `src/cors.test.ts` (1) |       33 |

### marketmaker

| Slice                                   | Scope                                                                                                                                                                                                                                                                                            | Findings |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------: |
| 1. state.ts part 1                      | `src/state.ts` lines 135-1196                                                                                                                                                                                                                                                                    |       46 |
| 2. state.ts part 2                      | `src/state.ts` lines 1201-1899                                                                                                                                                                                                                                                                   |       47 |
| 3. orderbook.ts part 1                  | `src/orderbook.ts` lines 188-350                                                                                                                                                                                                                                                                 |       45 |
| 4. orderbook.ts part 2                  | `src/orderbook.ts` lines 372-936                                                                                                                                                                                                                                                                 |       45 |
| 5. taker-proofs.ts part 1               | `src/taker-proofs.ts` lines 176-422                                                                                                                                                                                                                                                              |       38 |
| 6. taker-proofs.ts part 2               | `src/taker-proofs.ts` lines 428-775                                                                                                                                                                                                                                                              |       37 |
| 7. taker-state.ts part 1                | `src/taker-state.ts` lines 208-464                                                                                                                                                                                                                                                               |       38 |
| 8. taker-state.ts part 2                | `src/taker-state.ts` lines 475-879                                                                                                                                                                                                                                                               |       37 |
| 9. Taker harness                        | `src/taker-test-harness.ts` (46)                                                                                                                                                                                                                                                                 |       46 |
| 10. Maker state fixtures                | `src/state.test.ts` (45)                                                                                                                                                                                                                                                                         |       45 |
| 11. Taker CLI logging                   | `src/taker-cli.ts` (40)                                                                                                                                                                                                                                                                          |       40 |
| 12. Signing, wire and helpers           | `src/protocol-signing.ts` (25); `src/protocol-signing.test.ts` (11); `src/protocol-v2-wire.test.ts` (11); `src/protocol-v2-wire.ts` (1); `src/legacy-v1-test-helper.ts` (2); `src/protocol-v2-test-helper.ts` (2)                                                                                |       52 |
| 13. Orderbook, chain and HTLC adapters  | `src/orderbook.test.ts` (15); `src/chains.test.ts` (12); `src/htlc.ts` (12); `src/htlc.test.ts` (10); `src/qrl-web3-compat.test.ts` (5); `src/qrvmHtlc.test.ts` (3)                                                                                                                              |       57 |
| 14. Taker state and lifecycle           | `src/taker-state.test.ts` (22); `src/taker-e2e.test.ts` (11); `src/taker-orderbook.ts` (3); `src/taker-policy.ts` (2); `src/taker-policy.test.ts` (1); `src/taker-proofs.test.ts` (2); `src/taker.ts` (6); `src/taker-survival-child.ts` (5)                                                     |       52 |
| 15. Service CLI, pricing and guard tail | `src/credits-cli.ts` (10); `src/index.ts` (7); `src/init-keys.ts` (6); `src/price.ts` (6); `src/config.ts` (1); `src/deployment.ts` (1); `src/guards.ts` (1); `src/health.test.ts` (1); `src/config.test.ts` (2); `src/policy.test.ts` (2); `src/admission.test.ts` (4); `src/drain.test.ts` (4) |       45 |

## Validation before the bootstrap source-equality change

All commands below completed with the shown process exit codes, run from each package. Gate runs used `CI=true` and supplied `TSESTREE_SINGLE_RUN=true` externally to exercise the checker's override. All three manifests were regenerated with the base-aware update command; the frontend manifest remained byte-identical. The migration checks verified all 205 TypeScript files against `origin/dev` byte for byte.

| Command                                                | Frontend | Server | Marketmaker |
| ------------------------------------------------------ | -------: | -----: | ----------: |
| `npm run lint:ratchet:update -- --base-ref origin/dev` |        0 |      0 |           0 |
| `npm run format:check`                                 |        0 |      0 |           0 |
| `npm run lint`                                         |        0 |      0 |           0 |
| `npm run lint:ratchet -- --base-ref origin/dev`        |        0 |      0 |           0 |
| `npm run typecheck`                                    |        0 |      0 |           0 |
| `npm test`                                             |        0 |      0 |           0 |
| `npm run build`                                        |        0 |      0 |           0 |
| `node --test ../scripts/lint-ratchet.test.mjs`         |        0 |      0 |           0 |
| `actionlint`                                           |        0 |      0 |           0 |
| `npm run typecheck:loadtest`                           |      N/A |      0 |         N/A |

Application tests pass: frontend 475, server 217, and marketmaker 439. Server HTTP and federation smoke checks also pass. The shared policy suite passes 11 tests in each Node package. Frontend passes 10 policy tests and skips the Node registration case. Coverage includes allowed registrations and variants, unrelated promises and same-name functions, seven unhandled subtest call forms, awaited and returned subtests, and service/script/test logging boundaries.

The existing ratchet, directive, and suppression tests continue to pass. `actionlint` exits 0 from each package. Shared tooling and census formatting checks and `git diff --check` also exit 0. The frontend build retains its existing bundle-size warnings.

No application finding, TypeScript source, contract, dependency declaration, or lockfile changed. The full outgoing text scan found no Unicode U+2014, private hosts, IP literals, or workstation paths. All setup and policy changes remain uncommitted.
