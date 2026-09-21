import { cn } from "@/utils/cn";

// Omega bridge mark: the arch spans the old world (ETH, blue) on the left
// and the new (QRL, ember) on the right; the feet are the two-way crossing.
// The arcs keep their brand hues (battery blue / QRL orange); the disc behind them
// reads from the surface tokens. Arrowheads are deliberately oversized
// (roughly 2x the stroke width) after community feedback that the originals
// vanished at favicon sizes; keep them dominant in any future tweak.
const Mark = () => (
  <svg width="28" height="28" viewBox="0 0 120 120" aria-hidden>
    <circle
      cx="60"
      cy="60"
      r="56"
      fill="hsl(var(--muted))"
      stroke="hsl(var(--border))"
      strokeWidth="4"
    />
    <path
      d="M60 30 A 24 24 0 0 0 45 72 C 44.5 77 42 81 37 81 L 35 81"
      stroke="hsl(199 89% 64%)"
      strokeWidth="14"
      fill="none"
      strokeLinecap="butt"
      strokeLinejoin="round"
    />
    <polygon points="35,68 35,94 12,81" fill="hsl(199 89% 64%)" />
    <path
      d="M60 30 A 24 24 0 0 1 75 72 C 75.5 77 78 81 83 81 L 85 81"
      stroke="hsl(var(--secondary))"
      strokeWidth="14"
      fill="none"
      strokeLinecap="butt"
      strokeLinejoin="round"
    />
    <polygon points="85,68 85,94 108,81" fill="hsl(var(--secondary))" />
  </svg>
);

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 no-underline", className)}>
      <Mark />
      <span className="text-lg font-black italic tracking-tight">
        <span className="text-foreground">QUANTA</span>
        <span className="text-secondary">SWAP</span>
      </span>
    </span>
  );
}
