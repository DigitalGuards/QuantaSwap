import { Building2, Code2, FlaskConical, Scale, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { GITHUB_URL } from "@/config";

function Section({
  icon: Icon,
  title,
  children,
  accent = "secondary",
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
  accent?: "secondary" | "blue";
}) {
  return (
    <Card
      className={
        accent === "secondary" ? "border-l-2 border-l-secondary" : "border-l-2 border-l-blue-accent"
      }
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon
            className={accent === "secondary" ? "h-5 w-5 text-secondary" : "h-5 w-5 text-blue-accent"}
          />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
        {children}
      </CardContent>
    </Card>
  );
}

export function LegalPage() {
  return (
    <div className="page-enter mx-auto max-w-3xl space-y-6 py-6">
      <div>
        <h1 className="text-2xl font-bold">Legal notice</h1>
        <p className="mt-2 text-muted-foreground">
          What QuantaSwap is, what it is not, and who is behind it. Last updated: 14 July 2026.
        </p>
      </div>

      <Section icon={FlaskConical} title="Testnet only, no monetary value">
        <p>
          Everything on this site runs exclusively on test networks: the Ethereum Sepolia testnet
          and the QRL 2.0 (Zond) testnet. Sepolia ETH, testnet QRL, and the test tokens listed on
          the order book are test assets with no monetary value. They cannot be bought or sold for
          money and represent no claim on anyone. No real funds are involved anywhere on this
          site.
        </p>
        <p>
          The QuantaSwap contracts are not deployed on any mainnet. If a mainnet deployment
          happens in the future, it will be announced separately and will operate under its own
          terms and structure.
        </p>
      </Section>

      <Section icon={Scale} title="No services are provided" accent="blue">
        <p>
          QuantaSwap is free, experimental, open-source software: an interface to immutable
          hashed-timelock contracts that you interact with directly from your own wallets.
          DigitalGuards never holds, controls, or transmits your assets, does not execute swaps on
          your behalf, and charges no fees.
        </p>
        <p>
          Because everything here is limited to valueless test assets, no crypto-asset services
          within the meaning of Regulation (EU) 2023/1114 (MiCA) are provided, and nothing on this
          site is an offer, solicitation, or recommendation to buy, sell, or exchange any
          crypto-asset, nor investment, legal, or tax advice. The order book only introduces
          counterparties and never holds funds; any test liquidity present on it exists for
          demonstration purposes.
        </p>
      </Section>

      <Section icon={ShieldAlert} title="No warranty, use at your own risk">
        <p>
          This site and the underlying contracts are provided as-is and as-available, without
          warranties of any kind, in line with sections 15 and 16 of the GPL-3.0 license. This is
          experimental software under active development; expect bugs, resets, and breaking
          changes. To the maximum extent permitted by law, DigitalGuards accepts no liability for
          any loss or damage arising from its use.
        </p>
      </Section>

      <Section icon={Code2} title="Open source" accent="blue">
        <p>
          QuantaSwap is open source under the GPL-3.0 license. The contracts, frontend, order
          book, and market maker are published at{" "}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="text-blue-accent hover:underline"
          >
            github.com/DigitalGuards/QuantaSwap
          </a>
          .
        </p>
      </Section>

      <Section icon={Building2} title="Provider">
        <p>
          This site is operated by DigitalGuards, a sole proprietorship (eenmanszaak) registered
          in the Netherlands, Chamber of Commerce (KvK) number 91987482. Contact:{" "}
          <a href="mailto:info@digitalguards.nl" className="text-blue-accent hover:underline">
            info@digitalguards.nl
          </a>
          . The full imprint and the legal documents for the MyQRLWallet products are published
          at{" "}
          <a
            href="https://qrlwallet.com/legal"
            target="_blank"
            rel="noreferrer"
            className="text-blue-accent hover:underline"
          >
            qrlwallet.com/legal
          </a>
          .
        </p>
      </Section>
    </div>
  );
}
