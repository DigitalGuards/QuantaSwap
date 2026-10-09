import type { Eip1193Provider, ProviderDetail } from "@/hooks/useEthWallet";
import { isRecord, isString } from "@/utils/guards";

/** Providers supply callable capabilities; each request result stays unknown. */
export function isEip1193Provider(value: unknown): value is Eip1193Provider {
  return (
    isRecord(value) &&
    typeof value.request === "function" &&
    [value.on, value.off, value.removeListener].every(
      (method) => method === undefined || typeof method === "function",
    )
  );
}

export function isProviderDetail(value: unknown): value is ProviderDetail {
  return (
    isRecord(value) &&
    isRecord(value.info) &&
    [value.info.uuid, value.info.name, value.info.icon, value.info.rdns].every(isString) &&
    isEip1193Provider(value.provider)
  );
}
