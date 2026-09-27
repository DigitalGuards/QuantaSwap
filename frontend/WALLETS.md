# Ethereum wallet connections

Installed browser wallets use EIP-6963 discovery and EIP-1193 requests. MetaMask mobile uses the official MetaMask Connect SDK. WalletConnect uses `@walletconnect/ethereum-provider` and its Reown AppKit wallet directory, QR code and mobile handoff UI, themed to the app.

WalletConnect uses the official quantaswap.io Reown project by default. That public identifier only works on the domains allowlisted in its Reown dashboard (`quantaswap.io`, `dev.quantaswap.io`). A fork creates its own project in the [Reown dashboard](https://dashboard.reown.com/), allowlists its own domains, and sets `VITE_WALLETCONNECT_PROJECT_ID` before building, or sets it to `off` to hide WalletConnect. Installed wallets and MetaMask mobile work independently.

Only Ethereum Sepolia is requested. RPC reads keep using the existing Sepolia proxy. The transport loads when selected, or when restoring the user's previously selected WalletConnect session. Restoration checks an existing session without opening a pairing prompt. Disconnecting clears the remembered selection and closes the SDK session.

The QRL pairing component is `@qrlwallet/connect-ui`. Its release version and artifact integrity are pinned separately from the core `@qrlwallet/connect` SDK.


## HTLCv3 settlement gas, per wallet

A settlement (claim, refund, release, or a credit move) has to carry
`estimateGas + 250000`, the budget HTLCv3 publishes through
`deliveryGasPolicy()`. Below that the payout attempt runs out of its bounded
child-frame budget, and the amount stays with the contract as a credit the
payee has to collect. Measured on the deployed artifact, a bare estimate and
estimate * 1.3 both defer every time.

The browser sends the field on every transport. What the wallet does with it:

| Wallet | Honours the dApp gas limit | Effect on a settlement |
|---|---|---|
| MyQRLWallet web | yes | delivered |
| MyQRLWallet mobile | yes | delivered |
| MyQRLWallet browser extension | yes | delivered |
| MyQRLWallet desktop | no, it re-estimates at 1.2x | always deferred into a credit |
| QRL extension from theqrl.org | unverified | unknown |

A deferred payout loses nothing: the swap stays terminal, the credit is fully
backed, only the payee can redirect it, and the app surfaces it with a
withdrawal action as soon as the settlement lands. It costs the user one extra
transaction. The desktop fix is a change in the wallet and desktop
repositories, tracked outside this one.


## How a credit is attributed to one swap

`creditOf(token, account)` is a single ledger per address and asset, shared by
every swap that address has ever settled, so a balance alone cannot say which
swap left it. `PayoutCredited(token, account, hashlock, amount)` can: its third
indexed field names one swap. A client reads both and shows the smaller of the
two, because a withdrawal drains the ledger without naming a swap.

That pairing has one edge worth knowing. If this swap's credit is withdrawn and
a later swap credits the same address and asset, the new balance is
indistinguishable from the old one at the ledger, so this swap's page can
attribute it to itself again and offer to move it. Nothing is lost and nobody
gains anything: a withdrawal still pays only the account that owns the credit,
and a push still takes no destination. The cost is that the viewer may spend
gas moving a balance another swap created, and a page can show an amount that
is already spoken for elsewhere. The remainder above this swap's share is
labelled as belonging to other swaps for the same reason.
