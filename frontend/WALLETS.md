# Ethereum wallet connections

Installed browser wallets use EIP-6963 discovery and EIP-1193 requests. MetaMask mobile uses the official MetaMask Connect SDK. WalletConnect uses `@walletconnect/ethereum-provider` and its Reown AppKit wallet directory, QR code and mobile handoff UI, themed to the app.

WalletConnect uses the official quantaswap.io Reown project by default. That public identifier only works on the domains allowlisted in its Reown dashboard (`quantaswap.io`, `dev.quantaswap.io`). A fork creates its own project in the [Reown dashboard](https://dashboard.reown.com/), allowlists its own domains, and sets `VITE_WALLETCONNECT_PROJECT_ID` before building, or sets it to `off` to hide WalletConnect. Installed wallets and MetaMask mobile work independently.

Only Ethereum Sepolia is requested. RPC reads keep using the existing Sepolia proxy. The transport loads when selected, or when restoring the user's previously selected WalletConnect session. Restoration checks an existing session without opening a pairing prompt. Disconnecting clears the remembered selection and closes the SDK session.

The QRL pairing component is `@qrlwallet/connect-ui`. Its release version and artifact integrity are pinned separately from the core `@qrlwallet/connect` SDK.
