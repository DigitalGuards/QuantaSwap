import { cn } from "@/utils/cn";

// Omega bridge mark: the arch spans the old world (ETH, blue) on the left
// and the new (QRL, ember) on the right; the feet are the two-way crossing.
const Mark = () => (
  <svg width="28" height="28" viewBox="0 0 120 120" aria-hidden>
    <circle cx="60" cy="60" r="56" fill="hsl(217.2 32.6% 12%)" stroke="hsl(217.2 32.6% 25%)" strokeWidth="4" />
    <g transform="translate(0,5)">
      <path
        d="M60 28 A 26 26 0 0 0 44 74.5 C 43.5 79.5 41 83.5 36 83.5 L 35 83.5"
        stroke="hsl(199 89% 64%)"
        strokeWidth="12"
        fill="none"
        strokeLinecap="butt"
        strokeLinejoin="round"
      />
      <polygon points="35.5,76 35.5,91 21,83.5" fill="hsl(199 89% 64%)" />
      <path
        d="M60 28 A 26 26 0 0 1 76 74.5 C 76.5 79.5 79 83.5 84 83.5 L 85 83.5"
        stroke="hsl(25 95% 53%)"
        strokeWidth="12"
        fill="none"
        strokeLinecap="butt"
        strokeLinejoin="round"
      />
      <polygon points="84.5,76 84.5,91 99,83.5" fill="hsl(25 95% 53%)" />
    </g>
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
