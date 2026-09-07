import { useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { useEthWallet } from "@/hooks/useEthWallet";
import { useQrlWallet } from "@/hooks/useQrlWallet";
import { clearActiveSwap, loadActiveSwap, saveActiveSwap, type ActiveSwap } from "@/lib/activeSwap";
import { Header } from "@/components/Header";
import { RouteMeta } from "@/components/RouteMeta";
import { Footer } from "@/components/Footer";
import { PairingModal } from "@/components/PairingModal";
import { WalletPickerModal } from "@/components/WalletPickerModal";
import { EthWalletPickerModal } from "@/components/EthWalletPickerModal";
import { SwapPage } from "@/pages/SwapPage";
import { SandboxPage } from "@/pages/SandboxPage";
import { HowItWorksPage } from "@/pages/HowItWorksPage";
import { LegalPage } from "@/pages/LegalPage";
import { SwapStatusPage } from "@/pages/SwapStatusPage";
import { PrivateOrderPage } from "@/pages/PrivateOrderPage";

export default function App() {
  const eth = useEthWallet();
  const qrl = useQrlWallet();

  // One active swap at a time, shared by the market and sandbox pages and
  // persisted across refreshes (the preimage lives inside it).
  const [swap, setSwapState] = useState<ActiveSwap | null>(() => loadActiveSwap());
  const setSwap = (next: ActiveSwap | null) => {
    if (next) saveActiveSwap(next);
    else clearActiveSwap();
    setSwapState(next);
  };

  return (
    <BrowserRouter>
      <RouteMeta />
      <Header
        ethAccount={eth.account}
        ethPending={eth.pendingId !== null}
        onConnectEth={eth.openPicker}
        onDisconnectEth={() => void eth.disconnect()}
        qrlAccount={qrl.account}
        qrlStatus={qrl.status}
        onConnectQrl={qrl.connect}
        onDisconnectQrl={() => void qrl.disconnect()}
      />

      {eth.error && !eth.pickerOpen ? (
        <div
          role="alert"
          className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-center text-sm text-destructive"
        >
          {eth.error}
        </div>
      ) : null}

      {qrl.error ? (
        <div
          role="alert"
          className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-center text-sm text-destructive"
        >
          {qrl.error}
        </div>
      ) : null}

      <main className="mx-auto w-full max-w-5xl flex-1 px-4">
        <Routes>
          <Route
            path="/"
            element={<SwapPage eth={eth} qrl={qrl} swap={swap} setSwap={setSwap} />}
          />
          <Route
            path="/sandbox"
            element={<SandboxPage eth={eth} qrl={qrl} swap={swap} setSwap={setSwap} />}
          />
          <Route path="/how-it-works" element={<HowItWorksPage />} />
          <Route path="/legal" element={<LegalPage />} />
          <Route
            path="/swap/:hashlock"
            element={<SwapStatusPage eth={eth} qrl={qrl} swap={swap} setSwap={setSwap} />}
          />
          <Route
            path="/o/:id"
            element={<PrivateOrderPage eth={eth} qrl={qrl} swap={swap} setSwap={setSwap} />}
          />
          <Route
            path="*"
            element={<SwapPage eth={eth} qrl={qrl} swap={swap} setSwap={setSwap} />}
          />
        </Routes>
      </main>

      <Footer />

      <EthWalletPickerModal
        open={eth.pickerOpen}
        wallets={eth.providers}
        pendingId={eth.pendingId}
        error={eth.error}
        onSelect={(wallet) => void eth.connect(wallet)}
        onMetaMask={() => void eth.connectMetaMask()}
        onClose={eth.closePicker}
      />

      <WalletPickerModal
        open={qrl.pickerOpen}
        wallets={qrl.wallets}
        onSelect={(uuid) => void qrl.connectWallet(uuid)}
        onClose={qrl.closePicker}
      />

      {qrl.uri ? (
        <PairingModal
          uri={qrl.uri}
          statusDetail={qrl.statusDetail}
          onNewConnection={() => void qrl.newConnection()}
          onCancel={qrl.cancelPairing}
        />
      ) : null}
    </BrowserRouter>
  );
}
