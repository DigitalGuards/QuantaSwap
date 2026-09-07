import { Link } from "react-router";
import {
  ArrowLeftRight,
  BookOpen,
  Clock,
  Fuel,
  KeyRound,
  Lock,
  RefreshCcw,
  Repeat,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/UI/Button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/UI/Card";
import { INITIATOR_TIMEOUT_S, RESPONDER_TIMEOUT_S } from "@/config";

const INITIATOR_HOURS = Math.round(INITIATOR_TIMEOUT_S / 3600);
const RESPONDER_HOURS = Math.round(RESPONDER_TIMEOUT_S / 3600);

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
        accent === "secondary"
          ? "border-l-2 border-l-secondary"
          : "border-l-2 border-l-identity-accent"
      }
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon
            className={
              accent === "secondary" ? "h-5 w-5 text-secondary" : "h-5 w-5 text-identity-accent"
            }
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

export function HowItWorksPage() {
  return (
    <div className="page-enter mx-auto max-w-3xl space-y-6 py-6">
      <div>
        <h1 className="text-2xl font-bold">How QuantaSwap works</h1>
        <p className="mt-2 text-muted-foreground">
          A plain-language guide to trust-minimized cross-chain swaps.
        </p>
      </div>

      <Section icon={ArrowLeftRight} title="The problem QuantaSwap solves">
        <p>
          Moving value between Ethereum and QRL normally means a bridge or an exchange holding your
          coins for you. Both are custody: a bridge hack or a frozen account can take your funds.
          QuantaSwap swaps coins directly between the two chains using hashed timelock contracts, so
          no operator ever holds them. Every swap either completes on both sides or refunds on both.
        </p>
      </Section>

      <Section icon={BookOpen} title="Finding a counterparty: the order book" accent="blue">
        <p>
          Swaps start on the{" "}
          <Link to="/" className="text-identity-accent hover:underline">
            Swap page
          </Link>
          : post an order naming what you give and what you want, or take one someone else posted.
          The order book only introduces the two of you; it never holds funds, and both browsers
          verify every amount, recipient, and timeout directly on-chain before committing anything.
          If the order book vanished mid-swap, your coins would still settle or refund through the
          contracts alone.
        </p>
        <p>
          Curious how the handshake below actually feels, without waiting for a counterparty? The{" "}
          <Link to="/sandbox" className="text-identity-accent hover:underline">
            Sandbox
          </Link>{" "}
          lets you play both sides of a swap from one browser and watch every step land on both
          chains.
        </p>
      </Section>

      <Section icon={Lock} title="Step 1: Lock on both chains">
        <p>
          You generate a random 32-byte secret in your browser and hash it with sha256. That hash is
          the <strong>hashlock</strong>. You lock your coins on your chain against the hashlock, and
          your counterparty locks theirs on the other chain against the <em>same</em> hashlock.
        </p>
        <p>
          Neither lock can be spent without the secret, and each can be refunded to its owner once
          its timeout passes. Nothing is trusted yet: both sides are just escrowed to the same
          puzzle.
        </p>
      </Section>

      <Section icon={KeyRound} title="Step 2: One claim settles both legs" accent="blue">
        <p>
          To take the coins locked for you, you submit the secret. The contract checks that
          <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">sha256(secret)</code>
          equals the hashlock, then pays out. The instant you claim, your secret is visible
          on-chain.
        </p>
        <p>
          Your counterparty reads that secret and uses it to claim the other leg. One reveal unlocks
          both sides, so the swap is <strong>atomic</strong>: it is impossible for one party to walk
          away with both coins.
        </p>
      </Section>

      <Section icon={Clock} title="Step 3: Refund if it stalls">
        <p>
          Every lock carries a timeout. If a swap does not complete, whoever locked can refund their
          own coins once their timeout passes. The two timeouts are deliberately uneven: the
          initiator's is at least twice the responder's ({INITIATOR_HOURS}h versus {RESPONDER_HOURS}
          h in the current demo), which removes any window where a claim and a refund could both
          succeed.
        </p>
        <p>
          The outcome is always clean: you get the coins you wanted, or you get your own coins back.
          Never neither, never both.
        </p>
      </Section>

      <Section icon={Fuel} title="Receiving without gas" accent="blue">
        <p>
          The claim is <strong>permissionless</strong>, and the recipient is fixed at the moment the
          coins are locked. Anyone can submit the claim transaction, but the coins can only go to
          the address chosen at lock time.
        </p>
        <p>
          That means you can receive on a chain where you hold no gas at all. A relayer, or your
          counterparty, can pay the claim fee on your behalf and has no way to redirect the funds.
        </p>
      </Section>

      <Section icon={ShieldCheck} title="Security model">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>No owner, no pause, no upgrade.</strong> The HTLC contracts cannot be changed,
            halted, or drained by anyone, including us.
          </li>
          <li>
            <strong>Single-use hashlocks.</strong> Each hashlock works exactly once and is retired
            on-chain, so a revealed secret can never be replayed against a new swap.
          </li>
          <li>
            <strong>Post-quantum QRL leg.</strong> QRL signs with Dilithium ML-DSA-87, designed to
            withstand quantum computers; the QRL side of every swap inherits that protection.
          </li>
          <li>
            <strong>Your secret stays local.</strong> It is generated and held in your browser and
            only ever touches the chain when you choose to claim.
          </li>
        </ul>
        <p>
          Like all on-chain systems, smart-contract risk is never zero. QuantaSwap is testnet
          software today; do not swap value you cannot afford to lose.
        </p>
      </Section>

      <Section icon={RefreshCcw} title="QuantaSwap and MyQRLWallet" accent="blue">
        <p>
          QuantaSwap is built by the team behind{" "}
          <a
            href="https://qrlwallet.com"
            target="_blank"
            rel="noreferrer"
            className="text-identity-accent hover:underline"
          >
            MyQRLWallet
          </a>
          . You pair the QRL leg straight from the MyQRLWallet app, desktop, or web wallet over the
          post-quantum connect bridge, and bring any EIP-6963 wallet such as MetaMask for the
          Ethereum leg. A solver mode, a Phala TEE-attested solver for single-click swaps without
          running both legs yourself, is on the roadmap. Learn more about the wallet at{" "}
          <a
            href="https://myqrlwallet.com"
            target="_blank"
            rel="noreferrer"
            className="text-identity-accent hover:underline"
          >
            myqrlwallet.com
          </a>
          , or explore the chain on{" "}
          <a
            href="https://zondscan.com"
            target="_blank"
            rel="noreferrer"
            className="text-identity-accent hover:underline"
          >
            ZondScan
          </a>
          .
        </p>
      </Section>

      <div className="flex justify-center pt-2 pb-6">
        <Button size="lg" asChild>
          <Link to="/">
            <Repeat className="h-4 w-4" />
            Start a swap
          </Link>
        </Button>
      </div>
    </div>
  );
}
