# Lint setup census

Baseline: QuantaSwap `798214a0287b2c6d7193e0e2c57a5b78b57e2091` (`origin/dev` at setup).

Counts use the locked dependencies: ESLint 10.12.0, typescript-eslint 8.71.1, and TypeScript 5.8.3. No dependencies or TypeScript sources changed. Counts are diagnostic occurrences, so several findings can refer to one source expression. The versioned package manifests are the executable source of truth; this document records the setup snapshot.

## Enforcement

Every package uses strict-type-checked and stylistic-type-checked on all authored `.ts`, `.tsx`, `.mts`, and `.cts` files, including tests and scripts. The configured output exclusions for ESLint and the lint TypeScript projects cover `dist/`, `dist-loadtest/`, `build/`, and `coverage/` only directly under each package root. Installed `node_modules/` dependencies are excluded too. ESLint additionally ignores every nested `node_modules` directory by default, so every ratchet check and update first rejects any tracked repository path with that exact directory segment, regardless of depth or file type. This check reads the NUL-delimited Git index, includes sibling packages and shared paths, and runs through the existing CI lint gates. Untracked installed dependencies remain ignored. The repository inventory applies those exclusions at the repository root and the three package roots. Nested authored paths such as `src/build/`, `test/fixtures/dist/`, and `scripts/coverage/` remain linted and inventoried, including when Git ignores them. Shared hardening lives in `scripts/eslint-policy.mjs`; package configs retain their existing extra options. Assertions, explicit any, non-null assertions, floating promises, type imports, template expressions, console calls, and TypeScript comment directives follow the hardened wallet policy. Const assertions remain legal. Existing native-array fixture exceptions remain scoped in the Node packages.

The only checker is `scripts/lint-ratchet.mjs`, called by each package. `npm run lint` and `npm run lint:ratchet` check exact file/rule counts. `npm run lint:ratchet:update` can only lower counts or remove resolved pairs. Add `-- --base-ref origin/dev --integration-ref origin/dev` to compare the manifest with Git references. CI supplies the PR base SHA, the previous push SHA, or the current SHA for manual/tag runs, plus `origin/dev` as the integration reference. A version 1 base manifest is authoritative. If the base has a legacy or missing manifest, the checker uses a version 1 integration manifest in normal mode. This permits the first dev-to-main promotion after dev adopts the census, including existing differences between the branches. When neither reference has a version 1 manifest, bootstrap requires repository-wide source equality against the base and an exact current manifest as described below. The integration reference defaults to `origin/dev` for base-aware checks. Historical configuration is never executed and invalid reference manifests fail.

The checker sets `TSESTREE_SINGLE_RUN=false` before loading ESLint, ignores bulk suppressions, and rejects inline ESLint configuration in both TypeScript and package JavaScript tooling. Suppression guards cannot be ratcheted. The core no-warning-comments rule uses terms `["@ts-nocheck"]`, location `start`, and decoration `["/"]` to catch mixed-case directives and extra slashes. Guard and ratchet integration tests run in each package workflow. The integration suite uses complete isolated repository copies and temporary Git objects to test missing, legacy, and versioned base manifests. Every package exercises shared and sibling source changes with allowances, new `any` with an allowance, raised and lowered counts, extra and missing pairs, rejected updates without writes, exact bootstrap success, and saved-base growth and shrink behavior. The policy suite also checks repeated typed parsing across sources, tests, and scripts.

The five package workflows retain their job IDs and names. Each package job, including the orderbook browser job and both release jobs, installs dependencies and runs policy and integration tests, lint, the base-aware ratchet, and typecheck before application tests. Shared policy and ratchet changes trigger all three CI workflows. Tracked `**/node_modules/**` changes anywhere in the repository also trigger all three CI workflows on PRs and pushes. All three CI workflows cover pushes to dev and main and pass both ratchet references for PRs and pushes.

### Bootstrap source equality

Legacy and missing manifests both require every repository source and input to retain its base bytes when neither reference has adopted version 1. This deliberately includes all sibling packages and local dependencies, every file in each lint scope, shared `config/` inputs, declarations, tests, package metadata, and lockfiles. The checker compares raw worktree bytes with Git blob IDs, without Git clean filters or line-ending normalization. It checks base paths plus tracked and nonignored untracked paths, detecting additions, deletions, renames, and symlink replacements. It also walks authored JavaScript and TypeScript files, including Git-ignored sources, because ESLint does not honor `.gitignore`. Generated output, installed dependencies, and ignored local state are outside that inventory.

The complete bootstrap exception list is:

- The three packages' `eslint.config.js` or `eslint.config.mjs`, `eslint-ratchet.json`, `tsconfig.json`, and `tsconfig.eslint.json`. The main tsconfigs are inherited by the lint projects.
- `scripts/eslint-policy.mjs`, `scripts/lint-ratchet.mjs`, `scripts/lint-ratchet-lib.mjs`, `scripts/lint-ratchet.test.mjs`, and `scripts/lint-ratchet.integration.test.mjs`.
- The retired tooling paths `scripts/lint-ratchet-node-tests.mjs`, `scripts/eslint-node-test.mjs`, `frontend/scripts/check-lint-ratchet.mjs`, `server/lint.mjs`, and `marketmaker/lint.mjs`. These remain setup exceptions so their deletion passes the bootstrap freeze while the old paths are still in an uncommitted index.
- The `scripts` object in an existing `package.json`. Every other parsed field must remain equal, including dependency declarations, exports, type entry points, and package identity. JSON formatting and key order may change.
- `.github/workflows/*.yml` and `.github/workflows/*.yaml`.
- Markdown documentation (`*.md`) outside `config/`.

Any other source or input difference fails with `Bootstrap setup PR must not change sources` and the affected path. Repository-wide equality avoids maintaining an incomplete import or local-dependency graph. No base export or second lint scan occurs.

After equality passes, one scan of the checked package must produce exactly the manifest's file/rule pairs and counts. Extra pairs, missing pairs, higher counts, and lower counts all fail. Both check and update enforce equality before writing; failed updates preserve the manifest. Because sources match the base, this scan measures the base sources under the new policy. A legacy manifest receives the same freeze and exact-count checks as a missing manifest. Versioned reference ceilings and ordinary debt-reducing updates retain their existing behavior.

### Node test registrations and service logging

`no-floating-promises` applies to every authored TypeScript file in all three packages, including node:test registrations, subtests, and helpers. Existing unhandled registration promises are recorded as debt: 240 server findings and 506 marketmaker findings. All other rules and their counts remain unchanged.

During cleanup, mark top-level registrations that are intentionally not awaited with `void`, for example `void test("case", () => { /* assertions */ });`. Node supports discarding these top-level return values by design. Inside tests, await or return subtest promises, including any `Promise.all` that joins concurrent subtests, so the parent waits for completion. Review the nesting of each call before changing it. See the [Node test registration documentation](https://nodejs.org/api/test.html#testname-options-fn) and [subtest guidance](https://nodejs.org/api/test.html#subtests).

Policy tests check registrations, aliases, borrowed types, mutated members, ordinary promises, helpers, nested and hidden files, and all TypeScript test extensions under the same rule. They also check unhandled subtests and the intended `void`/await/return cleanup patterns. Ratchet unit and integration tests retain rejection of tracked `node_modules` segments at every depth, across packages and file types, in check and update modes without writing manifests. The integration tests use a private temporary Git index and leave the worktree index intact. Root-only output ignores, the bootstrap source freeze, suppression rejection, and saved count ceilings retain their existing coverage.

Runtime TypeScript and scripts in the two services allow only `console.info`, `console.warn`, and `console.error`. `console.log` and `console.debug` remain findings. Later cleanup slices can change those calls to `console.info` to preserve stdout. Tests and the named marketmaker test helpers retain the existing full `no-console` rule. No application finding was fixed in this policy update.

## Totals

| Package | TypeScript files scanned | Files with findings | Findings | File/rule pairs | Proposed slices |
| --- | ---: | ---: | ---: | ---: | ---: |
| frontend | 97 | 37 | 363 | 86 | 9 |
| server | 52 | 34 | 750 | 96 | 17 |
| marketmaker | 56 | 45 | 1,176 | 111 | 26 |

The census records 2,289 findings across 293 file/rule pairs. The 746 node:test registration findings are included in the manifests. The 37 permitted service logging calls remain outside the census under the existing logging policy. The plan contains 52 slices, each with 20 to 60 findings: the existing 36 slices cover 1,543 findings from other rules, and 16 registration slices cover the additional 746 findings.

## Findings by rule

Rule names beginning with `@typescript-eslint/` are shortened in this table. Zero means the rule has no current debt in that package.

| Rule                                | Frontend | Server | Marketmaker |
| ----------------------------------- | -------: | -----: | ----------: |
| `dot-notation`                      |       60 |    324 |         385 |
| `no-floating-promises`              | 0 | 240 | 506 |
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

## frontend: findings by file

Paths are relative to the package. All nonzero files are listed, largest first.

| File | Findings |
| --- | ---: |
| `src/lib/orderbookClient.ts` | 46 |
| `src/lib/orderSigning.test.ts` | 39 |
| `src/lib/orderbookClient.test.ts` | 37 |
| `src/lib/legSender.test.ts` | 29 |
| `src/lib/mirrorBook.test.ts` | 25 |
| `src/lib/payoutCredits.test.ts` | 19 |
| `src/lib/swapMachine.ts` | 19 |
| `src/lib/relayReset.test.ts` | 15 |
| `src/hooks/useEthWallet.test.tsx` | 13 |
| `src/lib/orderSigning.ts` | 13 |
| `src/hooks/useQrlWallet.test.tsx` | 12 |
| `src/lib/htlc.v3.test.ts` | 11 |
| `src/lib/mirrorBook.ts` | 11 |
| `src/lib/signedOrderRecovery.test.ts` | 9 |
| `src/components/signedOrderFlow.test.ts` | 7 |
| `src/components/PostOrderCard.tsx` | 6 |
| `src/config.ts` | 6 |
| `src/lib/htlc.test.ts` | 6 |
| `src/components/SwapFlow.credits.test.tsx` | 5 |
| `src/lib/payoutCreditedTopics.test.ts` | 4 |
| `src/components/MyOrderCard.tsx` | 3 |
| `src/hooks/useAnnounceReconcile.test.ts` | 3 |
| `src/lib/orderbook.ts` | 3 |
| `src/lib/walletConnect.test.ts` | 3 |
| `src/components/DeferredPayoutPanel.test.tsx` | 2 |
| `src/components/SwapFlow.tsx` | 2 |
| `src/components/signedOrderFlow.ts` | 2 |
| `src/hooks/useAnnounceReconcile.ts` | 2 |
| `src/lib/orderbook.test.ts` | 2 |
| `src/pages/SwapStatusPage.tsx` | 2 |
| `src/components/OrderBookPanel.tsx` | 1 |
| `src/components/PairingModal.test.tsx` | 1 |
| `src/hooks/useQrlWallet.ts` | 1 |
| `src/lib/protocol-v2-wire.ts` | 1 |
| `src/lib/relayReset.ts` | 1 |
| `src/pages/SwapPage.tsx` | 1 |
| `vite.config.ts` | 1 |

## server: findings by file

Paths are relative to the package. All nonzero files are listed, largest first.

| File | Findings |
| --- | ---: |
| `src/store.ts` | 126 |
| `src/peer-sync.test.ts` | 92 |
| `src/store-protocol.test.ts` | 54 |
| `src/federation.test.ts` | 47 |
| `src/order-signing.ts` | 44 |
| `src/process-lease.test.ts` | 38 |
| `src/order-signing.test.ts` | 33 |
| `src/peer-sync.ts` | 32 |
| `src/inflight-gate.test.ts` | 31 |
| `src/loadtest/scenarios.ts` | 28 |
| `src/loadtest/consistency.ts` | 26 |
| `src/federation.ts` | 25 |
| `src/loadtest/main.ts` | 23 |
| `src/server.ts` | 21 |
| `src/federation-reset.test.ts` | 17 |
| `src/lease-integration.test.ts` | 16 |
| `src/protocol-v2-wire.test.ts` | 15 |
| `src/store.test.ts` | 14 |
| `src/admission.test.ts` | 10 |
| `src/config.test.ts` | 10 |
| `src/peer-transport.test.ts` | 8 |
| `src/client-ip.test.ts` | 7 |
| `src/config.ts` | 6 |
| `src/cors.test.ts` | 5 |
| `src/qip55.test.ts` | 5 |
| `src/stream.test.ts` | 4 |
| `src/process-lease.ts` | 3 |
| `src/loadtest/probe-worker.ts` | 2 |
| `src/loadtest/reasons.ts` | 2 |
| `src/peer-transport.ts` | 2 |
| `src/guards.ts` | 1 |
| `src/healthcheck.ts` | 1 |
| `src/loadtest/proofs.ts` | 1 |
| `src/protocol-v2-wire.ts` | 1 |

## marketmaker: findings by file

Paths are relative to the package. All nonzero files are listed, largest first.

| File | Findings |
| --- | ---: |
| `src/state.test.ts` | 108 |
| `src/policy.test.ts` | 97 |
| `src/state.ts` | 93 |
| `src/orderbook.ts` | 90 |
| `src/taker-policy.test.ts` | 77 |
| `src/taker-proofs.ts` | 75 |
| `src/taker-state.ts` | 75 |
| `src/taker-state.test.ts` | 47 |
| `src/taker-test-harness.ts` | 46 |
| `src/htlc.test.ts` | 42 |
| `src/taker-e2e.test.ts` | 42 |
| `src/taker-proofs.test.ts` | 41 |
| `src/taker-cli.ts` | 40 |
| `src/price.test.ts` | 33 |
| `src/orderbook.test.ts` | 27 |
| `src/protocol-signing.ts` | 25 |
| `src/protocol-signing.test.ts` | 24 |
| `src/chains.test.ts` | 22 |
| `src/taker-cli.test.ts` | 22 |
| `src/protocol-v2-wire.test.ts` | 15 |
| `src/htlc.ts` | 12 |
| `src/config.test.ts` | 10 |
| `src/credits-cli.ts` | 10 |
| `src/qrvmHtlc.test.ts` | 9 |
| `src/admission.test.ts` | 8 |
| `src/drain.test.ts` | 8 |
| `src/health.test.ts` | 8 |
| `src/deployment.test.ts` | 7 |
| `src/index.ts` | 7 |
| `src/qrl-web3-compat.test.ts` | 7 |
| `src/init-keys.ts` | 6 |
| `src/price.ts` | 6 |
| `src/qip55.test.ts` | 6 |
| `src/taker.ts` | 6 |
| `src/taker-survival-child.ts` | 5 |
| `src/taker-survival.test.ts` | 4 |
| `src/init-keys.test.ts` | 3 |
| `src/taker-orderbook.ts` | 3 |
| `src/legacy-v1-test-helper.ts` | 2 |
| `src/protocol-v2-test-helper.ts` | 2 |
| `src/taker-policy.ts` | 2 |
| `src/config.ts` | 1 |
| `src/deployment.ts` | 1 |
| `src/guards.ts` | 1 |
| `src/protocol-v2-wire.ts` | 1 |

## Proposed cleanup slices

Each slice must preserve runtime behavior, shrink only its manifest allowances, and pass the full package gates. This policy update implements no cleanup slice. Counts partition every remaining finding exactly once; line ranges refer to this snapshot and identify diagnostic locations within large files.

Replace unsafe fixture casts with typed builders or guarded inputs. Review optional/nullish rewrites for behavioral equivalence. Runtime logging cleanup uses `console.info` for `console.log` and `console.debug`, preserving stdout; tests retain their existing console policy. Keep deterministic wire vectors aligned whenever a later slice changes the shared protocol encoder. Handle node:test registration findings using the `void` and subtest guidance above. The first 12 server slices and first 15 marketmaker slices count only findings from other rules; their registration-only slices follow and cover each `no-floating-promises` finding exactly once. Prioritize those registration slices for straightforward, reviewed debt reduction.

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
| 13. Registrations 1 | `src/admission.test.ts` lines 31-174 (9); `src/client-ip.test.ts` lines 5-91 (7); `src/config.test.ts` lines 7-370 (10); `src/cors.test.ts` lines 7-39 (4); `src/federation-reset.test.ts` lines 11-195 (16); `src/federation.test.ts` lines 78-79 (2) | 48 |
| 14. Registrations 2 | `src/federation.test.ts` lines 98-809 (27); `src/inflight-gate.test.ts` lines 230-578 (9); `src/lease-integration.test.ts` lines 154-394 (5); `src/order-signing.test.ts` lines 312-374 (7) | 48 |
| 15. Registrations 3 | `src/order-signing.test.ts` lines 395-869 (17); `src/peer-sync.test.ts` lines 49-1467 (31) | 48 |
| 16. Registrations 4 | `src/peer-sync.test.ts` lines 1584-1584 (1); `src/peer-transport.test.ts` lines 99-177 (6); `src/process-lease.test.ts` lines 106-672 (36); `src/protocol-v2-wire.test.ts` lines 103-219 (4); `src/qip55.test.ts` lines 12-12 (1) | 48 |
| 17. Registrations 5 | `src/qip55.test.ts` lines 17-43 (4); `src/store-protocol.test.ts` lines 342-1701 (34); `src/store.test.ts` lines 37-112 (6); `src/stream.test.ts` lines 28-61 (4) | 48 |

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
| 16. Registrations 1 | `src/admission.test.ts` lines 10-74 (4); `src/chains.test.ts` lines 144-272 (10); `src/config.test.ts` lines 8-106 (8); `src/deployment.test.ts` lines 19-107 (7); `src/drain.test.ts` lines 5-32 (4); `src/health.test.ts` lines 20-128 (7); `src/htlc.test.ts` lines 87-170 (6) | 46 |
| 17. Registrations 2 | `src/htlc.test.ts` lines 187-580 (26); `src/init-keys.test.ts` lines 22-44 (3); `src/orderbook.test.ts` lines 106-559 (12); `src/policy.test.ts` lines 161-208 (5) | 46 |
| 18. Registrations 3 | `src/policy.test.ts` lines 222-588 (46) | 46 |
| 19. Registrations 4 | `src/policy.test.ts` lines 597-1111 (44); `src/price.test.ts` lines 20-21 (2) | 46 |
| 20. Registrations 5 | `src/price.test.ts` lines 29-439 (31); `src/protocol-signing.test.ts` lines 75-603 (13); `src/protocol-v2-wire.test.ts` lines 103-118 (2) | 46 |
| 21. Registrations 6 | `src/protocol-v2-wire.test.ts` lines 143-219 (2); `src/qip55.test.ts` lines 14-56 (6); `src/qrl-web3-compat.test.ts` lines 29-30 (2); `src/qrvmHtlc.test.ts` lines 11-72 (6); `src/state.test.ts` lines 248-764 (30) | 46 |
| 22. Registrations 7 | `src/state.test.ts` lines 779-1633 (33); `src/taker-cli.test.ts` lines 27-135 (13) | 46 |
| 23. Registrations 8 | `src/taker-cli.test.ts` lines 144-197 (9); `src/taker-e2e.test.ts` lines 255-1152 (31); `src/taker-policy.test.ts` lines 143-167 (6) | 46 |
| 24. Registrations 9 | `src/taker-policy.test.ts` lines 173-574 (46) | 46 |
| 25. Registrations 10 | `src/taker-policy.test.ts` lines 586-851 (24); `src/taker-proofs.test.ts` lines 239-498 (22) | 46 |
| 26. Registrations 11 | `src/taker-proofs.test.ts` lines 512-733 (17); `src/taker-state.test.ts` lines 165-556 (25); `src/taker-survival.test.ts` lines 17-32 (4) | 46 |

## Validation

Validation used Node 22.22.3, `CI=true`, and externally supplied
`TSESTREE_SINGLE_RUN=true` to exercise the checker's override. Commands ran
from each package with `DISPLAY` and `WAYLAND_DISPLAY` unset. Values below are
process exit codes. All three manifests were regenerated from the full strict
scan; frontend remains byte-identical to its previous manifest. Ordinary
ratchet updates retain their zero-growth checks.

| Command | Frontend | Server | Marketmaker |
| --- | ---: | ---: | ---: |
| `npm run format:check` | 0 | 0 | 0 |
| `npm run lint` | 0 | 0 | 0 |
| `npm run lint:ratchet -- --base-ref origin/dev --integration-ref origin/dev` | 0 | 0 | 0 |
| `npm run lint:ratchet -- --base-ref origin/main --integration-ref origin/dev` | 1 | 1 | 1 |
| `npm run lint:ratchet -- --base-ref origin/main --integration-ref HEAD` | 0 | 1 | 1 |
| `npm run typecheck` | 0 | 0 | 0 |
| `npm test` | 0 | 0 | 0 |
| `npm run build` | 0 | 0 | 0 |
| `node --test ../scripts/lint-ratchet.test.mjs` | 0 | 0 | 0 |
| `node --test ../scripts/lint-ratchet.integration.test.mjs` | 0 | 0 | 0 |
| `actionlint` | 0 | 0 | 0 |
| `npm run typecheck:loadtest` | N/A | 0 | N/A |

At validation, `origin/dev` is `798214a`, `origin/main` is `f83f53b`, and
`HEAD` is `17c8d08`. Both remote-tracking refs have legacy manifests. The main
comparison therefore enforces bootstrap equality and rejects the pre-existing
`frontend/package-lock.json` difference between main and dev in all three
packages. Dependency declarations and lockfiles are unchanged in this update.

The committed-HEAD adoption comparison passes for frontend. Server and
marketmaker correctly reject growth against HEAD's older versioned manifests,
which recorded zero `no-floating-promises` findings. The new registration debt
is still uncommitted. Each integration suite separately verifies successful
adoption using isolated references built from the regenerated manifests,
including promotion from an older main source tree and rejection of subsequent
count growth. The actual refs and their count ceilings remain unchanged.

Application tests passed: frontend 475, server 217, and marketmaker 439.
Server HTTP and federation smoke checks passed. Each package passed 21 policy
unit tests and 28 ratchet integration tests. These include the retained tracked
`node_modules` rejection and the uniform floating-promise policy. The frontend
build retains its existing bundle-size warnings.

Shared tooling formatting, census rule totals and slice coverage,
`git diff --check`, and scans for Unicode U+2014, private infrastructure details,
and obsolete policy documentation passed with exit code 0. The 52 slices cover
all 2,289 findings exactly once. TypeScript application sources, contracts,
dependency declarations, and lockfiles remain unchanged. All edits remain
uncommitted and the worktree index is unchanged.
