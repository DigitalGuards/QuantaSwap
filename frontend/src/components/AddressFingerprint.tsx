import type { ComponentPropsWithoutRef } from "react";
import { shortAddr } from "@/lib/htlc";
import { cn } from "@/utils/cn";

interface AddressFingerprintProps extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  address: string;
}

/** Compact visual identity with the complete address available for inspection. */
export function AddressFingerprint({
  address,
  className,
  title,
  "aria-label": ariaLabel,
  ...props
}: AddressFingerprintProps) {
  return (
    <span
      {...props}
      className={cn("font-data", className)}
      title={title ?? address}
      aria-label={ariaLabel ?? address}
    >
      {shortAddr(address)}
    </span>
  );
}

interface ChainAddressPairProps {
  ethAddress?: string | null | undefined;
  qrlAddress?: string | null | undefined;
  className?: string;
}

/** Responsive ETH and QRL identities for order-maker and reserved-taker rows. */
export function ChainAddressPair({
  ethAddress,
  qrlAddress,
  className,
}: ChainAddressPairProps) {
  return (
    <span className={cn("grid min-w-0 justify-items-end gap-0.5", className)}>
      {ethAddress ? (
        <span className="max-w-full whitespace-nowrap text-[10px] sm:text-xs">
          <span className="mr-1 font-sans text-muted-foreground">ETH</span>
          <AddressFingerprint address={ethAddress} />
        </span>
      ) : null}
      {qrlAddress ? (
        <span className="max-w-full whitespace-nowrap text-[10px] sm:text-xs">
          <span className="mr-1 font-sans text-muted-foreground">QRL</span>
          <AddressFingerprint address={qrlAddress} />
        </span>
      ) : null}
    </span>
  );
}
