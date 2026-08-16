import { describe, expect, it, vi } from "vitest";
import { shake256 } from "@noble/hashes/sha3.js";
import {
  SCHEME_TAG_TYPED,
  computeTypedDataDigest,
  type QrlTypedDataPayload,
} from "@qrlwallet/connect";
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
  CANCEL_V1_FIELDS,
  FILL_INTENT_V1_FIELDS,
  FILL_V1_FIELDS,
  ORDER_V1_FIELDS,
  buildCancelV1Payload,
  buildFillIntentV1Payload,
  buildFillV1Payload,
  buildOrderV1Payload,
  cancelDigest,
  capabilityCommitment,
  computeReleaseCommitment,
  deriveOrderV1Id,
  fillDigest,
  intentDigest,
  orderDigest,
  orderSigningLabel,
  orderSigningSchemeForWallet,
  type CancelV1Body,
  type FillIntentV1Body,
  type FillV1Body,
  type ProtocolAuthV1,
  signCancelV1,
  signFillIntentV1,
  signFillV1,
  signOrderV1,
  verifyCancelV1,
  verifyFillIntentV1,
  verifyFillV1,
  verifyOrderV1Auth,
  verifyOrderCapabilities,
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

const NOW = 1_800_000_000;

const hex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString("hex")}`;

interface TestSigner {
  signer: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  descriptor: Uint8Array;
}

function testSigner(seed: number): TestSigner {
  const publicKey = new Uint8Array(CryptoPublicKeyBytes);
  const secretKey = new Uint8Array(CryptoSecretKeyBytes);
  cryptoSignKeypair(new Uint8Array(32).fill(seed), publicKey, secretKey);
  const descriptor = new Uint8Array([1, 0, 0]);
  const address = shake256(new Uint8Array([...descriptor, ...publicKey]), { dkLen: 20 });
  return {
    signer: `Q${Buffer.from(address).toString("hex")}`,
    publicKey,
    secretKey,
    descriptor,
  };
}

function signedProtocolAuth(
  scheme: "qrl-sign-typed-v1" | "qrl-eip712-v4",
  signer: TestSigner,
  fields: { issuedAt: number; expiresAt: number; nonce: string },
  payloadFor: (auth: ProtocolAuthV1) => ReturnType<typeof buildOrderV1Payload>,
): ProtocolAuthV1 {
  const auth: ProtocolAuthV1 = {
    version: "1",
    scheme,
    ...fields,
    signature: "",
    publicKey: hex(signer.publicKey),
    descriptor: hex(signer.descriptor),
  };
  const payload = payloadFor(auth);
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
                  { [payload.primaryType]: [...(payload.types[payload.primaryType] ?? [])] },
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
    signer.secretKey,
    false,
    scheme === "qrl-sign-typed-v1" ? SCHEME_TAG_TYPED : toUtf8Bytes("ZOND"),
  );
  auth.signature = hex(signature);
  return auth;
}

function walletRequest(
  scheme: "qrl-sign-typed-v1" | "qrl-eip712-v4",
  signer: TestSigner,
) {
  return vi.fn(async (args: { method: string; params?: unknown[] }) => {
    const payload = args.params?.[1] as QrlTypedDataPayload;
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
                    { [payload.primaryType]: [...(payload.types[payload.primaryType] ?? [])] },
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
      signer.secretKey,
      false,
      scheme === "qrl-sign-typed-v1" ? SCHEME_TAG_TYPED : toUtf8Bytes("ZOND"),
    );
    if (scheme === "qrl-eip712-v4") {
      return { signature: hex(signature), publicKey: hex(signer.publicKey) };
    }
    return {
      signature: hex(signature),
      publicKey: hex(signer.publicKey),
      descriptor: hex(signer.descriptor),
      signer: signer.signer,
      digest: hex(digest),
      schemeVersion: "QRL-SIGN-TYPED-v1",
      domain: payload.domain,
    };
  });
}

function verifiedFixture(
  scheme: "qrl-sign-typed-v1" | "qrl-eip712-v4",
  options: {
    expiresAt?: number;
    body?: Partial<CreateOrderBody>;
  } = {},
): OrderView {
  const maker = testSigner(9);
  const makerQrlAccount = maker.signer;
  const body: CreateOrderBody = {
    ...BODY,
    ...options.body,
    makerQrlAccount,
  };
  const auth: MakerOrderAuthV1 = {
    version: "1",
    scheme,
    issuedAt: 1_800_000_000,
    expiresAt: options.expiresAt ?? 1_800_003_600,
    nonce: `0x${"24".repeat(32)}`,
    makerTokenCommitment: capabilityCommitment("maker", "11".repeat(32)),
    shareTokenCommitment:
      body.visibility === "private"
        ? capabilityCommitment("share", "22".repeat(32))
        : `0x${"00".repeat(32)}`,
    signature: "",
    publicKey: hex(maker.publicKey),
    descriptor: hex(maker.descriptor),
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
    maker.secretKey,
    false,
    scheme === "qrl-sign-typed-v1" ? SCHEME_TAG_TYPED : toUtf8Bytes("ZOND"),
  );
  auth.signature = hex(signature);
  return {
    id: deriveOrderV1Id(makerQrlAccount, auth.nonce),
    direction: body.direction,
    asset: body.asset,
    fromAmount: body.fromAmount,
    toAmount: body.toAmount,
    makerEthAccount: body.makerEthAccount,
    makerQrlAccount,
    status: "open",
    takerEthAccount: null,
    takerQrlAccount: null,
    hashlock: body.prelock?.hashlock ?? null,
    initiatorTimeout: body.prelock?.initiatorTimeout ?? null,
    responderTimeout: null,
    visibility: body.visibility ?? "public",
    ...(body.allowedTakerEth === undefined ? {} : { allowedTakerEth: body.allowedTakerEth }),
    ...(body.allowedTakerQrl === undefined ? {} : { allowedTakerQrl: body.allowedTakerQrl }),
    prelocked: body.prelock !== undefined,
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
      makerTokenCommitment: capabilityCommitment("maker", "ab".repeat(32)),
      shareTokenCommitment: `0x${"00".repeat(32)}`,
    });
    const semantic = TypedDataEncoder.hash(
      payload.domain,
      { OrderV1: [...ORDER_V1_FIELDS] },
      payload.message,
    );
    expect(semantic).toBe(
      "0x5a76e96bdd26891fc5b28848ed2f519a9fee5d8bdc7614692b71a3431c085a48",
    );
    expect(
      keccak256(
        concat([toUtf8Bytes("\x19QRL Signed Message:\n32"), getBytes(semantic)]),
      ),
    ).toBe("0xc305e6936db7a0b374f936cb7058fde90963e39896f5d127f25bd87c147211d3");
  });

  it("matches the cross-package capability commitment vectors", () => {
    expect(capabilityCommitment("maker", "00".repeat(32))).toBe(
      "0x9ca8274349471eadc293ebb7690d81e64ce538ad0d9d65646f9ff1af227709e6",
    );
    expect(capabilityCommitment("share", "11".repeat(32))).toBe(
      "0xe0e4441fa2456254d19815bb0b962e160e06027efe181f8f8887292f527590e2",
    );
    expect(() => capabilityCommitment("maker", "AA".repeat(32))).toThrow(
      /lowercase hex/,
    );
  });

  it("matches the cross-package capability-aware child digest vectors", () => {
    const orderDigestHex =
      "0x5a76e96bdd26891fc5b28848ed2f519a9fee5d8bdc7614692b71a3431c085a48";
    const orderAuth = {
      issuedAt: NOW,
      expiresAt: NOW + 3600,
      nonce: `0x${"42".repeat(32)}`,
      makerTokenCommitment: capabilityCommitment("maker", "ab".repeat(32)),
      shareTokenCommitment: `0x${"00".repeat(32)}`,
    };
    const requestNonce = `0x${"43".repeat(32)}`;
    const releaseCommitment = computeReleaseCommitment(
      orderDigestHex,
      requestNonce,
      `0x${"55".repeat(32)}`,
    );
    expect(releaseCommitment).toBe(
      "0xa786c492a3707147bfa3277ddf44d49af0c794252e42dd05379f04b8c4621e0e",
    );
    const intent: FillIntentV1Body = {
      orderDigest: orderDigestHex,
      takerEthAccount: "0x2222222222222222222222222222222222222222",
      takerQrlAccount: "Q3333333333333333333333333333333333333333",
      releaseCommitment,
    };
    const intentAuth = {
      issuedAt: NOW + 10,
      expiresAt: NOW + 130,
      nonce: requestNonce,
    };
    const intentDigestHex = intentDigest(intent, intentAuth);
    expect(intentDigestHex).toBe(
      "0x48f387eff4522d99a48f52ec0e9e8b146fa0deb119383c53ffbb7d134ca00a2b",
    );
    expect(
      fillDigest(
        {
          ...intent,
          intentDigest: intentDigestHex,
          hashlock: `0x${"66".repeat(32)}`,
          initiatorTimeout: NOW + 3600,
          responderTimeout: NOW + 1800,
        },
        orderAuth,
        {
          issuedAt: NOW + 20,
          expiresAt: NOW + 80,
          nonce: `0x${"44".repeat(32)}`,
        },
      ),
    ).toBe("0x6d4d7d0a3fb70062fc6897c9f402353536e3ffeefe7a6e698b5db78cedcb3c13");
    expect(
      cancelDigest(
        { orderDigest: orderDigestHex, reasonCode: 1 },
        orderAuth,
        { issuedAt: NOW + 30, nonce: `0x${"45".repeat(32)}` },
      ),
    ).toBe("0xde9d19dc6dd94501ea1fb23ac89295ce139cc2f8566aee99f5b5ca5f83769214");
  });

  it("uses the official method while preserving the authorized signer parameter", async () => {
    const maker = testSigner(6);
    const requestedSigner = `Q${maker.signer.slice(1).toUpperCase()}`;
    const request = walletRequest("qrl-eip712-v4", maker);
    const signed = await signOrderV1({
      body: {
        ...BODY,
        makerEthAccount: BODY.makerEthAccount.toUpperCase().replace("0X", "0x"),
        makerQrlAccount: requestedSigner,
      },
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
      makerQrlAccount: maker.signer,
    });
    expect(signed.order.makerQrlAccount).toBe(maker.signer);
    expect(signed.auth.signature).toMatch(/^0x[0-9a-f]+$/);
    expect(signed.auth.descriptor).toBe("0x010000");
    expect(signed.makerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.shareToken).toBeUndefined();
    expect(
      verifyOrderCapabilities(signed.order, signed.auth, signed.makerToken),
    ).toBe(true);
    expect(
      verifyOrderCapabilities(signed.order, signed.auth, "ff".repeat(32)),
    ).toBe(false);
  });

  it("commits a share capability exactly for private orders", async () => {
    const maker = testSigner(5);
    const signed = await signOrderV1({
      body: { ...BODY, makerQrlAccount: maker.signer, visibility: "private" },
      walletRdns: "com.qrlwallet.extension",
      request: walletRequest("qrl-sign-typed-v1", maker),
      now: NOW,
    });
    expect(signed.shareToken).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.auth.shareTokenCommitment).not.toBe(`0x${"00".repeat(32)}`);
    expect(
      verifyOrderCapabilities(
        signed.order,
        signed.auth,
        signed.makerToken,
        signed.shareToken,
      ),
    ).toBe(true);
    expect(
      verifyOrderCapabilities(
        signed.order,
        signed.auth,
        signed.makerToken,
        "ff".repeat(32),
      ),
    ).toBe(false);
    expect(verifyOrderV1Auth({
      id: deriveOrderV1Id(signed.order.makerQrlAccount, signed.auth.nonce),
      ...signed.order,
      visibility: signed.order.visibility ?? "public",
      status: "open",
      takerEthAccount: null,
      takerQrlAccount: null,
      hashlock: null,
      initiatorTimeout: null,
      responderTimeout: null,
      createdAt: NOW,
      updatedAt: NOW,
      makerAuth: signed.auth,
    }, NOW + 1)).toBe(true);
  });

  it("caps a pre-funded order signature at its escrow timeout", async () => {
    const maker = testSigner(8);
    const request = walletRequest("qrl-eip712-v4", maker);
    const signed = await signOrderV1({
      body: {
        ...BODY,
        makerQrlAccount: maker.signer,
        prelock: {
          hashlock: `0x${"12".repeat(32)}`,
          initiatorTimeout: 1_800_010_800,
        },
      },
      walletRdns: "theqrl.org",
      request,
      now: 1_800_000_000,
    });
    expect(signed.auth.expiresAt).toBe(1_800_010_800);
  });

  it("rejects an official wallet proof that does not match the order", async () => {
    const maker = testSigner(6);
    const other = testSigner(7);
    await expect(
      signOrderV1({
        body: { ...BODY, makerQrlAccount: maker.signer },
        walletRdns: "theqrl.org",
        request: walletRequest("qrl-eip712-v4", other),
        now: NOW,
      }),
    ).rejects.toThrow(/does not match this order/);
  });

  it("fails closed for an unknown provider", async () => {
    const request = vi.fn();
    await expect(
      signOrderV1({ body: BODY, walletRdns: "example.invalid", request }),
    ).rejects.toThrow(/cannot sign portable orders/);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects noncanonical OrderV1 input before asking the wallet to sign", async () => {
    const request = vi.fn();
    const invalidBodies: Array<[CreateOrderBody, RegExp]> = [
      [{ ...BODY, direction: "eth<>qrl" } as unknown as CreateOrderBody, /direction/],
      [{ ...BODY, asset: "DOGE" } as unknown as CreateOrderBody, /asset/],
      [{ ...BODY, fromAmount: "01" }, /fromAmount/],
      [{ ...BODY, makerEthAccount: "0x1234" }, /makerEthAccount/],
      [{ ...BODY, makerQrlAccount: "Q1234" }, /makerQrlAccount/],
      [
        { ...BODY, allowedTakerEth: "0x3333333333333333333333333333333333333333" },
        /public orders cannot restrict/,
      ],
      [
        {
          ...BODY,
          prelock: {
            hashlock: `0x${"12".repeat(32)}`,
            initiatorTimeout: NOW,
          },
        },
        /3 to 72 hours/,
      ],
      [
        {
          ...BODY,
          prelock: {
            hashlock: `0x${"12".repeat(32)}`,
            initiatorTimeout: NOW + 72 * 3600 + 1,
          },
        },
        /3 to 72 hours/,
      ],
    ];

    for (const [body, message] of invalidBodies) {
      await expect(
        signOrderV1({
          body,
          walletRdns: "com.qrlwallet.extension",
          request,
          now: NOW,
        }),
      ).rejects.toThrow(message);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an OrderV1 expiry that cannot be represented safely", async () => {
    const request = vi.fn();
    await expect(
      signOrderV1({
        body: BODY,
        walletRdns: "com.qrlwallet.extension",
        request,
        now: Number.MAX_SAFE_INTEGER - 10,
      }),
    ).rejects.toThrow(/60 seconds of safe validity/);
    expect(request).not.toHaveBeenCalled();
  });

  it("derives signer-bound OrderV1 ids from raw address and nonce bytes", () => {
    const nonce = `0x${"42".repeat(32)}`;
    expect(
      deriveOrderV1Id("Q2222222222222222222222222222222222222222", nonce),
    ).toBe("cd84c99465b251d67a23548932b13fe84caa67d28c8331686e91774343552e0e");
    expect(
      deriveOrderV1Id("Q3333333333333333333333333333333333333333", nonce),
    ).not.toBe(deriveOrderV1Id("Q2222222222222222222222222222222222222222", nonce));
  });

  for (const scheme of ["qrl-sign-typed-v1", "qrl-eip712-v4"] as const) {
    it(`independently verifies received ${scheme} orders`, () => {
      const order = verifiedFixture(scheme);
      expect(verifyOrderV1Auth(order, 1_800_000_001)).toBe(true);
      expect(
        verifyOrderV1Auth({ ...order, toAmount: "3000000000000000" }, 1_800_000_001),
      ).toBe(false);
      expect(
        verifyOrderV1Auth(
          { ...order, direction: "elsewhere" } as unknown as OrderView,
          1_800_000_001,
        ),
      ).toBe(false);
      expect(
        verifyOrderV1Auth(
          { ...order, asset: "DOGE" } as unknown as OrderView,
          1_800_000_001,
        ),
      ).toBe(false);
      expect(
        verifyOrderV1Auth(
          {
            ...order,
            makerAuth: { ...order.makerAuth!, extra: "unsigned" },
          } as unknown as OrderView,
          1_800_000_001,
        ),
      ).toBe(false);
    });
  }

  it("rejects a signed prelock whose order proof outlives the escrow", () => {
    const order = verifiedFixture("qrl-sign-typed-v1", {
      expiresAt: NOW + 12_000,
      body: {
        prelock: {
          hashlock: `0x${"12".repeat(32)}`,
          initiatorTimeout: NOW + 10_800,
        },
      },
    });
    expect(verifyOrderV1Auth(order, NOW + 1)).toBe(false);
  });

  it("rejects signed prelocks outside the 3 to 72 hour issuance window", () => {
    for (const initiatorTimeout of [NOW + 10_799, NOW + 72 * 3600 + 1]) {
      const order = verifiedFixture("qrl-sign-typed-v1", {
        expiresAt: NOW + 3_600,
        body: {
          prelock: {
            hashlock: `0x${"12".repeat(32)}`,
            initiatorTimeout,
          },
        },
      });
      expect(verifyOrderV1Auth(order, NOW + 1)).toBe(false);
    }
  });
});

function orderBody(order: OrderView): CreateOrderBody {
  return {
    direction: order.direction,
    asset: order.asset ?? "ETH",
    fromAmount: order.fromAmount,
    toAmount: order.toAmount,
    makerEthAccount: order.makerEthAccount,
    makerQrlAccount: order.makerQrlAccount,
    visibility: order.visibility ?? "public",
  };
}

function signedIntentFixture(
  order: OrderView,
  scheme: "qrl-sign-typed-v1" | "qrl-eip712-v4",
  expiresAt = NOW + 121,
): { intent: FillIntentV1Body; auth: ProtocolAuthV1 } {
  const orderAuth = order.makerAuth!;
  const taker = testSigner(7);
  const requestNonce = `0x${"35".repeat(32)}`;
  const digest = orderDigest(orderBody(order), orderAuth);
  const intent: FillIntentV1Body = {
    orderDigest: digest,
    takerEthAccount: "0x3333333333333333333333333333333333333333",
    takerQrlAccount: taker.signer,
    releaseCommitment: computeReleaseCommitment(
      digest,
      requestNonce,
      `0x${"47".repeat(32)}`,
    ),
  };
  const auth = signedProtocolAuth(
    scheme,
    taker,
    { issuedAt: NOW + 1, expiresAt, nonce: requestNonce },
    (unsigned) => buildFillIntentV1Payload(intent, unsigned),
  );
  return { intent, auth };
}

function signedFillFixture(
  order: OrderView,
  signedIntent: { intent: FillIntentV1Body; auth: ProtocolAuthV1 },
  responseSeconds = 60,
  overrides: Partial<FillV1Body> = {},
  scheme = order.makerAuth!.scheme,
): { fill: FillV1Body; auth: ProtocolAuthV1 } {
  const orderAuth = order.makerAuth!;
  const maker = testSigner(9);
  const authFields = {
    issuedAt: NOW + 10,
    expiresAt: NOW + 10 + responseSeconds,
    nonce: `0x${"59".repeat(32)}`,
  };
  const fill: FillV1Body = {
    orderDigest: signedIntent.intent.orderDigest,
    intentDigest: intentDigest(signedIntent.intent, signedIntent.auth),
    takerEthAccount: signedIntent.intent.takerEthAccount,
    takerQrlAccount: signedIntent.intent.takerQrlAccount,
    releaseCommitment: signedIntent.intent.releaseCommitment,
    hashlock: `0x${"6b".repeat(32)}`,
    initiatorTimeout: NOW + 4_000,
    responderTimeout: NOW + 1_900,
    ...overrides,
  };
  const auth = signedProtocolAuth(
    scheme,
    maker,
    authFields,
    (unsigned) => buildFillV1Payload(fill, orderAuth, unsigned),
  );
  return { fill, auth };
}

function signedCancelFixture(
  order: OrderView,
  scheme = order.makerAuth!.scheme,
): { cancel: CancelV1Body; auth: ProtocolAuthV1 } {
  const orderAuth = order.makerAuth!;
  const cancel: CancelV1Body = {
    orderDigest: orderDigest(orderBody(order), orderAuth),
    reasonCode: 1,
  };
  const auth = signedProtocolAuth(
    scheme,
    testSigner(9),
    {
      issuedAt: NOW + 20,
      expiresAt: orderAuth.expiresAt,
      nonce: `0x${"7d".repeat(32)}`,
    },
    (unsigned) => buildCancelV1Payload(cancel, orderAuth, unsigned),
  );
  return { cancel, auth };
}

describe("federated order authorization", () => {
  for (const [scheme, rdns] of [
    ["qrl-sign-typed-v1", "com.qrlwallet.extension"],
    ["qrl-eip712-v4", "theqrl.org"],
  ] as const) {
    it(`signs FillIntentV1 through ${scheme}`, async () => {
      const order = verifiedFixture("qrl-sign-typed-v1");
      const taker = testSigner(7);
      const request = walletRequest(scheme, taker);
      const signed = await signFillIntentV1({
        body: {
          orderDigest: orderDigest(orderBody(order), order.makerAuth!),
          takerEthAccount: "0x3333333333333333333333333333333333333333",
          takerQrlAccount: taker.signer,
        },
        order,
        releaseSecret: `0x${"47".repeat(32)}`,
        walletRdns: rdns,
        request,
        now: NOW + 1,
        expiresAt: NOW + 121,
      });

      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]?.[0].method).toBe(
        scheme === "qrl-sign-typed-v1" ? "qrl_signTypedData" : "qrl_signTypedData_v4",
      );
      expect(verifyFillIntentV1(signed.intent, signed.auth, order, NOW + 20)).toBe(true);
    });
  }

  it("signs maker FillV1 and CancelV1 with the OrderV1 proof identity", async () => {
    const order = verifiedFixture("qrl-sign-typed-v1");
    const signedIntent = signedIntentFixture(order, "qrl-eip712-v4");
    const maker = testSigner(9);
    const request = walletRequest("qrl-sign-typed-v1", maker);
    const unsignedFill = signedFillFixture(order, signedIntent).fill;
    const signedFill = await signFillV1({
      body: unsignedFill,
      order,
      walletRdns: "com.qrlwallet.extension",
      request,
      respondBy: NOW + 70,
      now: NOW + 10,
    });
    const signedCancel = await signCancelV1({
      body: {
        orderDigest: orderDigest(orderBody(order), order.makerAuth!),
        reasonCode: 2,
      },
      order,
      walletRdns: "com.qrlwallet.extension",
      request,
      now: NOW + 20,
    });

    expect(signedFill.auth.publicKey).toBe(order.makerAuth?.publicKey);
    expect(signedFill.auth.descriptor).toBe(order.makerAuth?.descriptor);
    expect(verifyFillV1(signedFill.fill, signedFill.auth, order, signedIntent, NOW + 20)).toBe(
      true,
    );
    expect(verifyCancelV1(signedCancel.cancel, signedCancel.auth, order, NOW + 20)).toBe(true);
  });

  it("clamps FillIntentV1 expiry to the signed OrderV1 validity window", async () => {
    const order = verifiedFixture("qrl-sign-typed-v1", { expiresAt: NOW + 60 });
    const taker = testSigner(7);
    const request = walletRequest("qrl-sign-typed-v1", taker);
    const signed = await signFillIntentV1({
      body: {
        orderDigest: orderDigest(orderBody(order), order.makerAuth!),
        takerEthAccount: "0x3333333333333333333333333333333333333333",
        takerQrlAccount: taker.signer,
      },
      order,
      releaseSecret: `0x${"47".repeat(32)}`,
      walletRdns: "com.qrlwallet.extension",
      request,
      now: NOW + 1,
      expiresAt: NOW + 121,
    });

    expect(signed.auth.expiresAt).toBe(NOW + 60);
    expect(verifyFillIntentV1(signed.intent, signed.auth, order, NOW + 20)).toBe(true);
  });

  it("refuses to issue FillIntentV1 before the signed order issuance time", async () => {
    const order = verifiedFixture("qrl-sign-typed-v1");
    const request = walletRequest("qrl-sign-typed-v1", testSigner(7));
    await expect(
      signFillIntentV1({
        body: {
          orderDigest: orderDigest(orderBody(order), order.makerAuth!),
          takerEthAccount: "0x3333333333333333333333333333333333333333",
          takerQrlAccount: testSigner(7).signer,
        },
        order,
        releaseSecret: `0x${"47".repeat(32)}`,
        walletRdns: "com.qrlwallet.extension",
        request,
        now: NOW - 1,
      }),
    ).rejects.toThrow(/not valid yet/);
    expect(request).not.toHaveBeenCalled();
  });

  it("emits exact canonical child message bodies from mixed-case runtime input", async () => {
    const order = verifiedFixture("qrl-sign-typed-v1");
    const orderDigestHex = orderDigest(orderBody(order), order.makerAuth!);
    const upperBytes32 = (value: string) => `0x${value.slice(2).toUpperCase()}`;
    const taker = testSigner(7);
    const signedIntent = await signFillIntentV1({
      body: {
        orderDigest: upperBytes32(orderDigestHex),
        takerEthAccount: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        takerQrlAccount: `Q${taker.signer.slice(1).toUpperCase()}`,
        ignored: "drop me",
      } as Omit<FillIntentV1Body, "releaseCommitment">,
      order,
      releaseSecret: upperBytes32(`0x${"47".repeat(32)}`),
      walletRdns: "com.qrlwallet.extension",
      request: walletRequest("qrl-sign-typed-v1", taker),
      now: NOW + 1,
      expiresAt: NOW + 121,
    });
    expect(Object.keys(signedIntent.intent).sort()).toEqual([
      "orderDigest",
      "releaseCommitment",
      "takerEthAccount",
      "takerQrlAccount",
    ]);
    expect(signedIntent.intent).toMatchObject({
      orderDigest: orderDigestHex,
      takerEthAccount: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      takerQrlAccount: taker.signer,
    });

    const fillFixture = signedFillFixture(order, signedIntent);
    const signedFill = await signFillV1({
      body: {
        ...fillFixture.fill,
        orderDigest: upperBytes32(fillFixture.fill.orderDigest),
        intentDigest: upperBytes32(fillFixture.fill.intentDigest),
        releaseCommitment: upperBytes32(fillFixture.fill.releaseCommitment),
        hashlock: upperBytes32(fillFixture.fill.hashlock),
        takerEthAccount: fillFixture.fill.takerEthAccount.toUpperCase().replace("0X", "0x"),
        takerQrlAccount: `Q${fillFixture.fill.takerQrlAccount.slice(1).toUpperCase()}`,
        ignored: "drop me",
      } as FillV1Body,
      order,
      walletRdns: "com.qrlwallet.extension",
      request: walletRequest("qrl-sign-typed-v1", testSigner(9)),
      respondBy: NOW + 70,
      now: NOW + 10,
    });
    expect(Object.keys(signedFill.fill).sort()).toEqual([
      "hashlock",
      "initiatorTimeout",
      "intentDigest",
      "orderDigest",
      "releaseCommitment",
      "responderTimeout",
      "takerEthAccount",
      "takerQrlAccount",
    ]);
    expect(signedFill.fill.orderDigest).toBe(fillFixture.fill.orderDigest);
    expect(signedFill.fill.intentDigest).toBe(fillFixture.fill.intentDigest);
    expect(signedFill.fill.releaseCommitment).toBe(fillFixture.fill.releaseCommitment);
    expect(signedFill.fill.hashlock).toBe(fillFixture.fill.hashlock);

    const signedCancel = await signCancelV1({
      body: {
        orderDigest: upperBytes32(orderDigestHex),
        reasonCode: 2,
        ignored: "drop me",
      } as CancelV1Body,
      order,
      walletRdns: "com.qrlwallet.extension",
      request: walletRequest("qrl-sign-typed-v1", testSigner(9)),
      now: NOW + 20,
    });
    expect(Object.keys(signedCancel.cancel).sort()).toEqual(["orderDigest", "reasonCode"]);
    expect(signedCancel.cancel).toEqual({ orderDigest: orderDigestHex, reasonCode: 2 });
  });

  it("rejects cancellation exactly at OrderV1 expiry before signing", async () => {
    const order = verifiedFixture("qrl-sign-typed-v1", { expiresAt: NOW + 60 });
    const request = walletRequest("qrl-sign-typed-v1", testSigner(9));
    await expect(
      signCancelV1({
        body: {
          orderDigest: orderDigest(orderBody(order), order.makerAuth!),
          reasonCode: 1,
        },
        order,
        walletRdns: "com.qrlwallet.extension",
        request,
        now: NOW + 60,
      }),
    ).rejects.toThrow(/already expired/);
    expect(request).not.toHaveBeenCalled();
  });

  it("builds exact CAIP-bound typed payloads", () => {
    const order = verifiedFixture("qrl-sign-typed-v1");
    const orderAuth = order.makerAuth!;
    const signedIntent = signedIntentFixture(order, "qrl-sign-typed-v1");
    const intentPayload = buildFillIntentV1Payload(signedIntent.intent, signedIntent.auth);

    expect(intentPayload.types.FillIntentV1).toEqual(FILL_INTENT_V1_FIELDS);
    expect(intentPayload.message).toMatchObject({
      orderDigest: signedIntent.intent.orderDigest,
      requestNonce: signedIntent.auth.nonce,
      takerEthAccount:
        "eip155:11155111:0x3333333333333333333333333333333333333333",
      takerQrlAccount: signedIntent.intent.takerQrlAccount,
      issuedAt: String(NOW + 1),
      expiresAt: String(NOW + 121),
      ethChainId: "11155111",
      qrlChainId: "1337",
    });

    const signedFill = signedFillFixture(order, signedIntent);
    const fillPayload = buildFillV1Payload(signedFill.fill, orderAuth, signedFill.auth);
    expect(fillPayload.types.FillV1).toEqual(FILL_V1_FIELDS);
    expect(fillPayload.message).toMatchObject({
      orderNonce: orderAuth.nonce,
      fillNonce: signedFill.auth.nonce,
      intentDigest: signedFill.fill.intentDigest,
      takerEthAccount:
        "eip155:11155111:0x3333333333333333333333333333333333333333",
      initiatorTimeout: String(NOW + 4_000),
      responderTimeout: String(NOW + 1_900),
      respondBy: String(NOW + 70),
    });

    const signedCancel = signedCancelFixture(order);
    const cancelPayload = buildCancelV1Payload(
      signedCancel.cancel,
      orderAuth,
      signedCancel.auth,
    );
    expect(cancelPayload.types.CancelV1).toEqual(CANCEL_V1_FIELDS);
    expect(cancelPayload.message).toMatchObject({
      orderNonce: orderAuth.nonce,
      cancelNonce: signedCancel.auth.nonce,
      issuedAt: String(NOW + 20),
      reasonCode: 1,
    });
  });

  it("derives scheme-independent semantic digests", () => {
    const order = verifiedFixture("qrl-sign-typed-v1");
    const signedIntent = signedIntentFixture(order, "qrl-eip712-v4");
    const custom = buildFillIntentV1Payload(signedIntent.intent, {
      ...signedIntent.auth,
      scheme: "qrl-sign-typed-v1",
    });
    const official = buildFillIntentV1Payload(signedIntent.intent, {
      ...signedIntent.auth,
      scheme: "qrl-eip712-v4",
    });
    const digest = intentDigest(signedIntent.intent, signedIntent.auth);
    expect(custom.message).toEqual(official.message);
    expect(digest).toBe(
      TypedDataEncoder.hash(
        official.domain,
        { FillIntentV1: [...FILL_INTENT_V1_FIELDS] },
        official.message,
      ),
    );
    expect(
      intentDigest(
        { ...signedIntent.intent, releaseCommitment: `0x${"ab".repeat(32)}` },
        signedIntent.auth,
      ),
    ).not.toBe(digest);

    const signedFill = signedFillFixture(order, signedIntent);
    const signedCancel = signedCancelFixture(order);
    expect(fillDigest(signedFill.fill, order.makerAuth!, signedFill.auth)).toMatch(
      /^0x[0-9a-f]{64}$/,
    );
    expect(
      cancelDigest(signedCancel.cancel, order.makerAuth!, signedCancel.auth),
    ).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("matches the domain-separated release commitment vector", () => {
    expect(
      computeReleaseCommitment(
        `0x${"11".repeat(32)}`,
        `0x${"22".repeat(32)}`,
        `0x${"33".repeat(32)}`,
      ),
    ).toBe("0x5fc8c5fdfc3b3df859a6d0883c794662e325ff10147adb67f6ac7a677e442702");
    expect(() =>
      computeReleaseCommitment(
        `0x${"11".repeat(32)}`,
        `0x${"22".repeat(32)}`,
        `0x${"AA".repeat(32)}`,
      ),
    ).toThrow(/lowercase bytes32/);
  });

  for (const makerScheme of ["qrl-sign-typed-v1", "qrl-eip712-v4"] as const) {
    it(`verifies intent, fill, and cancel proofs for ${makerScheme} orders`, () => {
      const order = verifiedFixture(makerScheme);
      const takerScheme =
        makerScheme === "qrl-sign-typed-v1" ? "qrl-eip712-v4" : "qrl-sign-typed-v1";
      const signedIntent = signedIntentFixture(order, takerScheme);
      const signedFill = signedFillFixture(order, signedIntent);
      const signedCancel = signedCancelFixture(order);

      expect(verifyFillIntentV1(signedIntent.intent, signedIntent.auth, order, NOW + 20)).toBe(
        true,
      );
      expect(verifyFillV1(signedFill.fill, signedFill.auth, order, signedIntent, NOW + 20)).toBe(
        true,
      );
      expect(verifyCancelV1(signedCancel.cancel, signedCancel.auth, order, NOW + 20)).toBe(
        true,
      );
      expect(
        verifyFillV1(
          { ...signedFill.fill, hashlock: `0x${"9a".repeat(32)}` },
          signedFill.auth,
          order,
          signedIntent,
          NOW + 20,
        ),
      ).toBe(false);
    });
  }

  for (const [orderScheme, terminalScheme] of [
    ["qrl-sign-typed-v1", "qrl-eip712-v4"],
    ["qrl-eip712-v4", "qrl-sign-typed-v1"],
  ] as const) {
    it(`accepts ${terminalScheme} terminal proofs for a ${orderScheme} order`, () => {
      const order = verifiedFixture(orderScheme);
      const signedIntent = signedIntentFixture(order, "qrl-sign-typed-v1");
      const signedFill = signedFillFixture(order, signedIntent, 60, {}, terminalScheme);
      const signedCancel = signedCancelFixture(order, terminalScheme);

      expect(
        verifyFillV1(signedFill.fill, signedFill.auth, order, signedIntent, NOW + 20),
      ).toBe(true);
      expect(
        verifyCancelV1(signedCancel.cancel, signedCancel.auth, order, NOW + 20),
      ).toBe(true);
    });
  }

  it("rejects expired request windows, short fill deadlines, and unbound cancel expiry", () => {
    const order = verifiedFixture("qrl-sign-typed-v1");
    const longIntent = signedIntentFixture(order, "qrl-sign-typed-v1", NOW + 122);
    expect(verifyFillIntentV1(longIntent.intent, longIntent.auth, order, NOW + 20)).toBe(false);

    const signedIntent = signedIntentFixture(order, "qrl-sign-typed-v1");
    const shortFill = signedFillFixture(order, signedIntent, 59);
    expect(verifyFillV1(shortFill.fill, shortFill.auth, order, signedIntent, NOW + 20)).toBe(
      false,
    );

    const signedCancel = signedCancelFixture(order);
    expect(
      verifyCancelV1(
        signedCancel.cancel,
        { ...signedCancel.auth, expiresAt: signedCancel.auth.expiresAt - 1 },
        order,
        NOW + 20,
      ),
    ).toBe(false);
  });

  it("rejects FillV1 respondBy after OrderV1 expiry during recovery verification", () => {
    const order = verifiedFixture("qrl-sign-typed-v1", { expiresAt: NOW + 65 });
    const signedIntent = signedIntentFixture(order, "qrl-sign-typed-v1", NOW + 50);
    const signedFill = signedFillFixture(order, signedIntent, 60);

    expect(
      verifyFillV1(signedFill.fill, signedFill.auth, order, signedIntent, {
        now: NOW + 200,
        allowExpired: true,
      }),
    ).toBe(false);
  });

  it("rejects oversized FillV1 escrow windows before signing and on verification", async () => {
    const order = verifiedFixture("qrl-sign-typed-v1");
    const signedIntent = signedIntentFixture(order, "qrl-sign-typed-v1");
    const multiYear = signedFillFixture(order, signedIntent, 60, {
      initiatorTimeout: NOW + 10 * 365 * 24 * 3600,
    });
    expect(verifyFillV1(multiYear.fill, multiYear.auth, order, signedIntent, NOW + 20)).toBe(
      false,
    );

    const makerRequest = walletRequest("qrl-sign-typed-v1", testSigner(9));
    await expect(
      signFillV1({
        body: multiYear.fill,
        order,
        walletRdns: "com.qrlwallet.extension",
        request: makerRequest,
        respondBy: NOW + 70,
        now: NOW + 10,
      }),
    ).rejects.toThrow(/4 hours/);
    expect(makerRequest).not.toHaveBeenCalled();

    const longResponder = signedFillFixture(order, signedIntent, 60, {
      initiatorTimeout: NOW + 14_400,
      responderTimeout: NOW + 7_211,
    });
    expect(
      verifyFillV1(longResponder.fill, longResponder.auth, order, signedIntent, NOW + 20),
    ).toBe(false);
  });
});
