import { cn } from "@/utils/cn";

const Mark = () => (
  <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden>
    <circle cx="16" cy="16" r="14" fill="hsl(217.2 32.6% 12%)" stroke="hsl(217.2 32.6% 25%)" />
    <path
      d="M9 13a7 7 0 0 1 12-3l2 2m0-5v5h-5"
      stroke="hsl(25 95% 53%)"
      strokeWidth="2.4"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M23 19a7 7 0 0 1-12 3l-2-2m0 5v-5h5"
      stroke="hsl(199 89% 64%)"
      strokeWidth="2.4"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
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
