// Worker side of the harness signing pool. ML-DSA-87 signing costs tens of
// milliseconds, so pre-signing a few thousand proofs on one thread would
// dominate the run. Each worker derives its own key material from the seed it
// is handed and signs the canonical message bytes the main thread built.

import { parentPort } from "node:worker_threads";
import { SCHEME_TAG_MSG, computeMessageDigest } from "@qrlwallet/connect";
import {
  CryptoBytes,
  CryptoPublicKeyBytes,
  CryptoSecretKeyBytes,
  cryptoSignKeypair,
  cryptoSignSignature,
} from "@theqrl/mldsa87";

export interface SignTask {
  id: number;
  seedHex: string;
  messages: Uint8Array[];
}

export interface SignResult {
  id: number;
  signatures: Uint8Array[];
}

const port = parentPort;
if (port === null) throw new Error("signing worker requires a parent port");

const secretKeys = new Map<string, Uint8Array>();

function secretKeyFor(seedHex: string): Uint8Array {
  const cached = secretKeys.get(seedHex);
  if (cached !== undefined) return cached;
  const publicKey = new Uint8Array(CryptoPublicKeyBytes);
  const secretKey = new Uint8Array(CryptoSecretKeyBytes);
  cryptoSignKeypair(Buffer.from(seedHex, "hex"), publicKey, secretKey);
  secretKeys.set(seedHex, secretKey);
  return secretKey;
}

port.on("message", (task: SignTask) => {
  const secretKey = secretKeyFor(task.seedHex);
  const signatures = task.messages.map((message) => {
    const signature = new Uint8Array(CryptoBytes);
    cryptoSignSignature(
      signature,
      computeMessageDigest(message),
      secretKey,
      false,
      SCHEME_TAG_MSG,
    );
    return signature;
  });
  const result: SignResult = { id: task.id, signatures };
  port.postMessage(result);
});
