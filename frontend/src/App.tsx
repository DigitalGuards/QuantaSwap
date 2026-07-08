import { BrowserRouter, Route, Routes } from "react-router-dom";
import { useEthWallet } from "@/hooks/useEthWallet";
import { useQrlWallet } from "@/hooks/useQrlWallet";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { QrModal } from "@/components/QrModal";
import { SwapPage } from "@/pages/SwapPage";
import { HowItWorksPage } from "@/pages/HowItWorksPage";

export default function App() {
  const eth = useEthWallet();
  const qrl = useQrlWallet();

  return (
    <BrowserRouter>
      <Header
        ethAccount={eth.account}
        onConnectEth={() => void eth.connect()}
        onDisconnectEth={() => eth.disconnect()}
        qrlAccount={qrl.account}
        qrlStatus={qrl.status}
        onConnectQrl={() => void qrl.connect()}
        onDisconnectQrl={() => void qrl.disconnect()}
      />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4">
        <Routes>
          <Route path="/" element={<SwapPage eth={eth} qrl={qrl} />} />
          <Route path="/how-it-works" element={<HowItWorksPage />} />
          <Route path="*" element={<SwapPage eth={eth} qrl={qrl} />} />
        </Routes>
      </main>

      <Footer />

      {qrl.uri ? (
        <QrModal
          uri={qrl.uri}
          statusDetail={qrl.statusDetail}
          onNewConnection={() => void qrl.newConnection()}
          onCancel={qrl.cancelPairing}
        />
      ) : null}
    </BrowserRouter>
  );
}
