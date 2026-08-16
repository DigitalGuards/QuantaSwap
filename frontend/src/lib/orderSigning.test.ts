import { describe, expect, it, vi } from "vitest";
import { shake256 } from "@noble/hashes/sha3.js";
import { SCHEME_TAG_TYPED, computeTypedDataDigest } from "@qrlwallet/connect";
import {
  CryptoBytes,
  CryptoPublicKeyBytes,
  CryptoSecretKeyBytes,
  cryptoSignKeypair,
  cryptoSignSignature,
} from "@theqrl/mldsa87";
import {
  TypedDataEncoder,
  concat,
  getBytes,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import type { CreateOrderBody, MakerOrderAuthV1, OrderView } from "./orderbook";
import {
  ORDER_V1_FIELDS,
  buildOrderV1Payload,
  orderSigningLabel,
  orderSigningSchemeForWallet,
  signOrderV1,
  verifyOrderV1Auth,
} from "./orderSigning";

const BODY: CreateOrderBody = {
  direction: "eth->qrl",
  asset: "ETH",
  fromAmount: "1000000000000000",
  toAmount: "2000000000000000",
  makerEthAccount: "0x1111111111111111111111111111111111111111",
  makerQrlAccount: "Q2222222222222222222222222222222222222222",
  visibility: "public",
};

const hex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString("hex")}`;

function verifiedFixture(scheme: "qrl-sign-typed-v1" | "qrl-eip712-v4"): OrderView {
  const publicKey = new Uint8Array(CryptoPublicKeyBytes);
  const secretKey = new Uint8Array(CryptoSecretKeyBytes);
  cryptoSignKeypair(new Uint8Array(32).fill(9), publicKey, secretKey);
  const descriptor = new Uint8Array([1, 0, 0]);
  const address = shake256(new Uint8Array([...descriptor, ...publicKey]), { dkLen: 20 });
  const makerQrlAccount = `Q${Buffer.from(address).toString("hex")}`;
  const body = { ...BODY, makerQrlAccount };
  const auth: MakerOrderAuthV1 = {
    version: "1",
    scheme,
    issuedAt: 1_800_000_000,
    expiresAt: 1_800_003_600,
    nonce: `0x${"24".repeat(32)}`,
    signature: "",
    publicKey: hex(publicKey),
    descriptor: hex(descriptor),
  };
  const payload = buildOrderV1Payload(body, auth);
  const digest =
    scheme === "qrl-sign-typed-v1"
      ? computeTypedDataDigest(payload)
      : getBytes(
          keccak256(
            concat([
              toUtf8Bytes("\x19QRL Signed Message:\n32"),
              getBytes(
                TypedDataEncoder.hash(
                  payload.domain,
                  { OrderV1: [...ORDER_V1_FIELDS] },
                  payload.message,
                ),
              ),
            ]),
          ),
        );
  const signature = new Uint8Array(CryptoBytes);
  cryptoSignSignature(
    signature,
    digest,
    secretKey,
    false,
    scheme === "qrl-sign-typed-v1" ? SCHEME_TAG_TYPED : toUtf8Bytes("ZOND"),
  );
  auth.signature = hex(signature);
  return {
    id: auth.nonce.slice(2),
    direction: body.direction,
    asset: body.asset,
    fromAmount: body.fromAmount,
    toAmount: body.toAmount,
    makerEthAccount: body.makerEthAccount,
    makerQrlAccount,
    status: "open",
    takerEthAccount: null,
    takerQrlAccount: null,
    hashlock: null,
    initiatorTimeout: null,
    responderTimeout: null,
    visibility: "public",
    createdAt: auth.issuedAt,
    updatedAt: auth.issuedAt,
    makerAuth: auth,
  };
}

describe("OrderV1 wallet signing", () => {
  it("selects a scheme from the selected provider identity", () => {
    expect(orderSigningSchemeForWallet("com.qrlwallet.connect")).toBe("qrl-sign-typed-v1");
    expect(orderSigningSchemeForWallet("com.qrlwallet.extension")).toBe("qrl-sign-typed-v1");
    expect(orderSigningSchemeForWallet("theqrl.org")).toBe("qrl-eip712-v4");
    expect(orderSigningSchemeForWallet(null)).toBeNull();
    expect(orderSigningLabel("theqrl.org")).toContain("Official QRL wallet");
  });

  it("matches the official QRL web3 ABI 0.5.0 EIP-712 vector", () => {
    const payload = buildOrderV1Payload(BODY, {
      scheme: "qrl-eip712-v4",
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_003_600,
      nonce: `0x${"42".repeat(32)}`,
    });
    expect(
      TypedDataEncoder.hash(
        payload.domain,
        { OrderV1: [...ORDER_V1_FIELDS] },
        payload.message,
      ),
    ).toBe("0xd822b6033a8e089ad0af54605be20f2957bbafa4d855df04104ac4978cc85035");
  });

  it("uses the official method while preserving the authorized signer parameter", async () => {
    const requestedSigner = "Q22222222222222222222222222222222222222Aa";
    const request = vi.fn(async (_args: { method: string; params?: unknown[] }) => ({
      signature: "ab".repeat(4627),
      publicKey: `0x${"cd".repeat(2592)}`,
    }));
    const signed = await signOrderV1({
      body: { ...BODY, makerQrlAccount: requestedSigner },
      walletRdns: "theqrl.org",
      request,
      now: 1_800_000_000,
    });

    expect(request).toHaveBeenCalledOnce();
    const call = request.mock.calls[0]?.[0];
    expect(call?.method).toBe("qrl_signTypedData_v4");
    expect(call?.params?.[0]).toBe(requestedSigner);
    expect((call?.params?.[1] as { message: Record<string, unknown> }).message).toMatchObject({
      makerEthAccount: "eip155:11155111:0x1111111111111111111111111111111111111111",
      makerQrlAccount: "Q22222222222222222222222222222222222222aa",
    });
    expect(signed.order.makerQrlAccount).toBe(
      "Q22222222222222222222222222222222222222aa",
    );
    expect(signed.auth.signature).toBe(`0x${"ab".repeat(4627)}`);
    expect(signed.auth.descriptor).toBe("0x010000");
  });

  it("caps a pre-funded order signature at its escrow timeout", async () => {
    const request = vi.fn(async () => ({
      signature: `0x${"ab".repeat(4627)}`,
      publicKey: `0x${"cd".repeat(2592)}`,
    }));
    const signed = await signOrderV1({
      body: {
        ...BODY,
        prelock: {
          hashlock: `0x${"12".repeat(32)}`,
          initiatorTimeout: 1_800_010_000,
        },
      },
      walletRdns: "theqrl.org",
      request,
      now: 1_800_000_000,
    });
    expect(signed.auth.expiresAt).toBe(1_800_010_000);
  });

  it("fails closed for an unknown provider", async () => {
    const request = vi.fn();
    await expect(
      signOrderV1({ body: BODY, walletRdns: "example.invalid", request }),
    ).rejects.toThrow(/cannot sign portable orders/);
    expect(request).not.toHaveBeenCalled();
  });

  for (const scheme of ["qrl-sign-typed-v1", "qrl-eip712-v4"] as const) {
    it(`independently verifies received ${scheme} orders`, () => {
      const order = verifiedFixture(scheme);
      expect(verifyOrderV1Auth(order, 1_800_000_001)).toBe(true);
      expect(
        verifyOrderV1Auth({ ...order, toAmount: "3000000000000000" }, 1_800_000_001),
      ).toBe(false);
    });
  }
});
