import { clock } from "@/lib/swapNowLine";

interface Props {
  /** Seconds waited so far. */
  elapsedS: number;
  /** Length of the window in seconds. Without it the bar only shows motion. */
  totalS?: number;
  label: string;
  note?: string | undefined;
  testId?: string;
}

/**
 * A small wait indicator: a label with the elapsed time and a thin bar. With
 * a known window the bar fills toward its end. Without one a short segment
 * slides along the bar every second, so a wait that depends on the next block
 * visibly moves. Usage: <WaitMeter elapsedS={42} totalS={180} label="Waiting" />
 */
export function WaitMeter({ elapsedS, totalS, label, note, testId }: Props) {
  const determinate = totalS !== undefined && totalS > 0;
  const fraction = determinate ? Math.min(1, Math.max(0, elapsedS / totalS)) : 0;
  const slide = (Math.max(0, elapsedS) % 8) / 8;
  return (
    <div className="space-y-1" data-testid={testId}>
      <p className="text-xs text-foreground">
        {label} <span className="font-data tabular-nums">{clock(elapsedS)}</span>
        {determinate ? (
          <span className="font-data tabular-nums text-muted-foreground"> of {clock(totalS)}</span>
        ) : null}
      </p>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? totalS : undefined}
        aria-valuenow={
          determinate ? Math.min(totalS, Math.max(0, Math.floor(elapsedS))) : undefined
        }
        className="relative h-1 w-full max-w-xs overflow-hidden rounded-full bg-muted/50"
      >
        <div
          className="absolute inset-y-0 rounded-full bg-identity-accent/70 motion-safe:transition-all motion-safe:duration-1000 motion-safe:ease-linear"
          style={
            determinate
              ? { left: 0, width: `${String(Math.round(fraction * 100))}%` }
              : { left: `${String(Math.round(slide * 80))}%`, width: "20%" }
          }
        />
      </div>
      {note !== undefined ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
