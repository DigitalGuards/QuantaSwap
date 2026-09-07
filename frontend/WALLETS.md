# Ethereum wallet connections

Installed browser wallets use EIP-6963 discovery and EIP-1193 requests. MetaMask mobile uses the official MetaMask Connect SDK. WalletConnect uses `@walletconnect/ethereum-provider` and its Reown AppKit wallet directory, QR code and mobile handoff UI, themed to the app.

To enable WalletConnect, create a project in the [Reown dashboard](https://dashboard.reown.com/), allow the app's domains in its origin settings, and set `VITE_WALLETCONNECT_PROJECT_ID` before building the frontend. This is a public application identifier. The wallet chooser shows WalletConnect when the identifier is configured; installed wallets and MetaMask mobile work independently.

Only Ethereum Sepolia is requested. RPC reads keep using the existing Sepolia proxy. The transport loads when selected, or when restoring the user's previously selected WalletConnect session. Restoration checks an existing session without opening a pairing prompt. Disconnecting clears the remembered selection and closes the SDK session.

The QRL pairing component is `@qrlwallet/connect-ui`. Its release version and artifact integrity are pinned separately from the core `@qrlwallet/connect` SDK.
