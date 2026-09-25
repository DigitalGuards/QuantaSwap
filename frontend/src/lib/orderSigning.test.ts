import { describe, expect, it, vi } from "vitest";
import { shake256 } from "@noble/hashes/sha3.js";
import {
  SCHEME_TAG_MSG,
  computeMessageDigest,
} from "@qrlwallet/connect";
import {
  CryptoBytes,
  CryptoPublicKeyBytes,
  CryptoSecretKeyBytes,
  cryptoSignKeypair,
  cryptoSignSignature,
} from "@theqrl/mldsa87";
import { getBytes } from "ethers";
import { sha256 } from "@noble/hashes/sha2.js";
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
import { protocolMessageBytes } from "./protocol-v2-wire";
import { canonicalQip55QrlAddress, isQip55QrlAddress } from "./qip55";
import vectors from "../../../config/protocol-v2-vectors.json";

const BODY: CreateOrderBody = {
  direction: "eth->qrl",
  asset: "ETH",
  fromAmount: "1000000000000000",
  toAmount: "2000000000000000",
  makerEthAccount: "0x1111111111111111111111111111111111111111",
  makerQrlAccount: `Q${"2".repeat(128)}`,
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
  const address = shake256(new Uint8Array([...descriptor, ...publicKey]), { dkLen: 64 });
  return {
    signer: `Q${Buffer.from(address).toString("hex")}`,
    publicKey,
    secretKey,
    descriptor,
  };
}

function signedProtocolAuth(
  scheme: "qrl-sign-message-v2",
  signer: TestSigner,
  fields: { issuedAt: number; expiresAt: number; nonce: string },
  payloadFor: (auth: ProtocolAuthV1) => ReturnType<typeof buildOrderV1Payload>,
): ProtocolAuthV1 {
  const auth: ProtocolAuthV1 = {
    version: "2",
    scheme,
    ...fields,
    signature: "",
    publicKey: hex(signer.publicKey),
    descriptor: hex(signer.descriptor),
  };
  const payload = payloadFor(auth);
  const digest = computeMessageDigest(protocolMessageBytes(payload));
  const signature = new Uint8Array(CryptoBytes);
  cryptoSignSignature(
    signature,
    digest,
    signer.secretKey,
    false,
    SCHEME_TAG_MSG,
  );
  auth.signature = hex(signature);
  return auth;
}

function walletRequest(
  scheme: "qrl-sign-message-v2",
  signer: TestSigner,
) {
  return vi.fn(async (args: { method: string; params?: unknown[] }) => {
    expect(scheme).toBe("qrl-sign-message-v2");
    expect(args.method).toBe("qrl_signMessage");
    const digest = computeMessageDigest(getBytes(args.params?.[1] as string));
    const signature = new Uint8Array(CryptoBytes);
    cryptoSignSignature(
      signature,
      digest,
      signer.secretKey,
      false,
      SCHEME_TAG_MSG,
    );
    return {
      signature: hex(signature),
      publicKey: hex(signer.publicKey),
      descriptor: hex(signer.descriptor),
      signer: signer.signer,
      digest: hex(digest),
      schemeVersion: "QRL-SIGN-MSG-v1",
    };
  });
}

function verifiedFixture(
  scheme: "qrl-sign-message-v2",
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
    version: "2",
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
  const digest = computeMessageDigest(protocolMessageBytes(payload));
  const signature = new Uint8Array(CryptoBytes);
  cryptoSignSignature(
    signature,
    digest,
    maker.secretKey,
    false,
    SCHEME_TAG_MSG,
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
    expect(orderSigningSchemeForWallet("com.qrlwallet.connect")).toBe("qrl-sign-message-v2");
    expect(orderSigningSchemeForWallet("com.qrlwallet.extension")).toBe("qrl-sign-message-v2");
    expect(orderSigningSchemeForWallet("theqrl.org")).toBeNull();
    expect(orderSigningSchemeForWallet(null)).toBeNull();
    expect(orderSigningLabel("com.qrlwallet.extension")).toContain("MyQRLWallet");
  });

  it("pins the V2 domain and ordered message schema", () => {
    const payload = buildOrderV1Payload(BODY, {
      scheme: "qrl-sign-message-v2",
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_003_600,
      nonce: `0x${"42".repeat(32)}`,
      makerTokenCommitment: capabilityCommitment("maker", "ab".repeat(32)),
      shareTokenCommitment: `0x${"00".repeat(32)}`,
    });
    expect(payload.primaryType).toBe("OrderV2");
    expect(payload.types.OrderV2).toEqual(ORDER_V1_FIELDS);
    expect(payload.domain).toEqual(vectors.domain);
    expect(hex(sha256(protocolMessageBytes(payload)))).toBe(vectors.expected.orderDigest);
    expect(hex(computeMessageDigest(protocolMessageBytes(payload)))).toBe(vectors.expected.messageDigest);
    expect(payload.domain).toMatchObject({ version: "2", qrlChainId: "3151909", qrlGenesisHash: "0xd15407991193e6c23b733dc6bf9c628deaff8f9b6e252aa0d60030952b3e3ea4" });
    expect(new TextDecoder().decode(protocolMessageBytes(payload))).toMatch(/^QuantaSwap Protocol V2\u0000\["2","OrderV2"/);
    expect(() => protocolMessageBytes({ ...payload, domain: { ...payload.domain, version: "1" } })).toThrow(/domain/);
  });

  it("matches the cross-package capability commitment vectors", () => {
    expect(capabilityCommitment("maker", "00".repeat(32))).toBe(
      vectors.expected.makerCapabilityZero,
    );
    expect(capabilityCommitment("share", "11".repeat(32))).toBe(
      vectors.expected.shareCapabilityOne,
    );
    expect(() => capabilityCommitment("maker", "AA".repeat(32))).toThrow(
      /lowercase hex/,
    );
  });

  it("matches the cross-package capability-aware child digest vectors", () => {
    const orderDigestHex = vectors.expected.orderDigest;
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
      vectors.expected.releaseCommitment,
    );
    const intent: FillIntentV1Body = {
      orderDigest: orderDigestHex,
      takerEthAccount: "0x2222222222222222222222222222222222222222",
      takerQrlAccount: `Q${"3".repeat(128)}`,
      releaseCommitment,
    };
    const intentAuth = {
      issuedAt: NOW + 10,
      expiresAt: NOW + 130,
      nonce: requestNonce,
    };
    const intentDigestHex = intentDigest(intent, intentAuth);
    expect(intentDigestHex).toBe(
      vectors.expected.intentDigest,
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
    ).toBe(vectors.expected.fillDigest);
    expect(
      cancelDigest(
        { orderDigest: orderDigestHex, reasonCode: 1 },
        orderAuth,
        { issuedAt: NOW + 30, nonce: `0x${"45".repeat(32)}` },
      ),
    ).toBe(vectors.expected.cancelDigest);
  });

  it("uses qrl_signMessage while preserving the authorized signer parameter", async () => {
    const maker = testSigner(6);
    const requestedSigner = `Q${maker.signer.slice(1).toUpperCase()}`;
    const request = walletRequest("qrl-sign-message-v2", maker);
    const signed = await signOrderV1({
      body: {
        ...BODY,
        makerEthAccount: BODY.makerEthAccount.toUpperCase().replace("0X", "0x"),
        makerQrlAccount: requestedSigner,
      },
      walletRdns: "com.qrlwallet.connect",
      request,
      now: 1_800_000_000,
    });

    expect(request).toHaveBeenCalledOnce();
    const call = request.mock.calls[0]?.[0];
    expect(call?.method).toBe("qrl_signMessage");
    expect(call?.params?.[0]).toBe(requestedSigner);
    const message = new TextDecoder().decode(getBytes(call?.params?.[1] as string));
    expect(message).toContain("eip155:11155111:0x1111111111111111111111111111111111111111");
    expect(message).toContain(maker.signer);
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
      request: walletRequest("qrl-sign-message-v2", maker),
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

  it("rejects an invalid allowed-taker checksum before requesting a signature", async () => {
    const maker = testSigner(5);
    const recipient = canonicalQip55QrlAddress(testSigner(7).signer);
    const malformedRecipient = recipient.replace(/[a-fA-F]/, (character) =>
      character === character.toLowerCase()
        ? character.toUpperCase()
        : character.toLowerCase(),
    );
    expect(isQip55QrlAddress(malformedRecipient)).toBe(false);
    const request = walletRequest("qrl-sign-message-v2", maker);
    await expect(
      signOrderV1({
        body: {
          ...BODY,
          makerQrlAccount: maker.signer,
          visibility: "private",
          allowedTakerQrl: malformedRecipient,
        },
        walletRdns: "com.qrlwallet.extension",
        request,
        now: NOW,
      }),
    ).rejects.toThrow("order.allowedTakerQrl must be a QRL address");
    expect(request).not.toHaveBeenCalled();
  });

  it("caps a pre-funded order signature at its escrow timeout", async () => {
    const maker = testSigner(8);
    const request = walletRequest("qrl-sign-message-v2", maker);
    const signed = await signOrderV1({
      body: {
        ...BODY,
        makerQrlAccount: maker.signer,
        prelock: {
          hashlock: `0x${"12".repeat(32)}`,
          initiatorTimeout: 1_800_010_800,
        },
      },
      walletRdns: "com.qrlwallet.connect",
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
        walletRdns: "com.qrlwallet.connect",
        request: walletRequest("qrl-sign-message-v2", other),
        now: NOW,
      }),
    ).rejects.toThrow(/does not match this V2 message/);
  });

  it("fails closed for an unknown provider", async () => {
    const request = vi.fn();
    await expect(
      signOrderV1({ body: BODY, walletRdns: "example.invalid", request }),
    ).rejects.toThrow(/cannot sign portable orders/);
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a legacy account before requesting an OrderV2 signature", async () => {
    const request = vi.fn();
    await expect(
      signOrderV1({
        body: { ...BODY, makerQrlAccount: `Q${"12".repeat(20)}` },
        walletRdns: "com.qrlwallet.extension",
        request,
        now: NOW,
      }),
    ).rejects.toThrow(/64-byte|QIP-55/);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects noncanonical OrderV1 input before asking the wallet to sign", async () => {
    const request = vi.fn();
    const invalidBodies: Array<[CreateOrderBody, RegExp]> = [
      [{ ...BODY, direction: "eth<>qrl" } as unknown as CreateOrderBody, /direction/],
      [{ ...BODY, asset: "DOGE" } as unknown as CreateOrderBody, /asset/],
      [{ ...BODY, fromAmount: "01" }, /fromAmount/],
      [{ ...BODY, makerEthAccount: "0x1234" }, /makerEthAccount/],
      [{ ...BODY, makerQrlAccount: "Q1234" }, /64-byte|QIP-55/],
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
      deriveOrderV1Id(`Q${"2".repeat(128)}`, nonce),
    ).toBe(vectors.expected.orderId);
    expect(
      deriveOrderV1Id(`Q${"3".repeat(128)}`, nonce),
    ).not.toBe(deriveOrderV1Id(`Q${"2".repeat(128)}`, nonce));
  });

  for (const scheme of ["qrl-sign-message-v2"] as const) {
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
    const order = verifiedFixture("qrl-sign-message-v2", {
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
      const order = verifiedFixture("qrl-sign-message-v2", {
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
  scheme: "qrl-sign-message-v2",
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
    ["qrl-sign-message-v2", "com.qrlwallet.extension"],
    ["qrl-sign-message-v2", "com.qrlwallet.connect"],
  ] as const) {
    it(`signs FillIntentV1 through ${scheme}`, async () => {
      const order = verifiedFixture("qrl-sign-message-v2");
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
        "qrl_signMessage",
      );
      expect(verifyFillIntentV1(signed.intent, signed.auth, order, NOW + 20)).toBe(true);
    });
  }

  it("signs maker FillV1 and CancelV1 with the OrderV1 proof identity", async () => {
    const order = verifiedFixture("qrl-sign-message-v2");
    const signedIntent = signedIntentFixture(order, "qrl-sign-message-v2");
    const maker = testSigner(9);
    const request = walletRequest("qrl-sign-message-v2", maker);
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
    const order = verifiedFixture("qrl-sign-message-v2", { expiresAt: NOW + 60 });
    const taker = testSigner(7);
    const request = walletRequest("qrl-sign-message-v2", taker);
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
    const order = verifiedFixture("qrl-sign-message-v2");
    const request = walletRequest("qrl-sign-message-v2", testSigner(7));
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
    const order = verifiedFixture("qrl-sign-message-v2");
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
      request: walletRequest("qrl-sign-message-v2", taker),
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
      request: walletRequest("qrl-sign-message-v2", testSigner(9)),
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
      request: walletRequest("qrl-sign-message-v2", testSigner(9)),
      now: NOW + 20,
    });
    expect(Object.keys(signedCancel.cancel).sort()).toEqual(["orderDigest", "reasonCode"]);
    expect(signedCancel.cancel).toEqual({ orderDigest: orderDigestHex, reasonCode: 2 });
  });

  it("rejects cancellation exactly at OrderV1 expiry before signing", async () => {
    const order = verifiedFixture("qrl-sign-message-v2", { expiresAt: NOW + 60 });
    const request = walletRequest("qrl-sign-message-v2", testSigner(9));
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
    const order = verifiedFixture("qrl-sign-message-v2");
    const orderAuth = order.makerAuth!;
    const signedIntent = signedIntentFixture(order, "qrl-sign-message-v2");
    const intentPayload = buildFillIntentV1Payload(signedIntent.intent, signedIntent.auth);

    expect(intentPayload.types.FillIntentV2).toEqual(FILL_INTENT_V1_FIELDS);
    expect(intentPayload.message).toMatchObject({
      orderDigest: signedIntent.intent.orderDigest,
      requestNonce: signedIntent.auth.nonce,
      takerEthAccount:
        "eip155:11155111:0x3333333333333333333333333333333333333333",
      takerQrlAccount: signedIntent.intent.takerQrlAccount,
      issuedAt: String(NOW + 1),
      expiresAt: String(NOW + 121),
      ethChainId: "11155111",
      qrlChainId: "3151909",
    });

    const signedFill = signedFillFixture(order, signedIntent);
    const fillPayload = buildFillV1Payload(signedFill.fill, orderAuth, signedFill.auth);
    expect(fillPayload.types.FillV2).toEqual(FILL_V1_FIELDS);
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
    expect(cancelPayload.types.CancelV2).toEqual(CANCEL_V1_FIELDS);
    expect(cancelPayload.message).toMatchObject({
      orderNonce: orderAuth.nonce,
      cancelNonce: signedCancel.auth.nonce,
      issuedAt: String(NOW + 20),
      reasonCode: 1,
    });
  });

  it("derives scheme-independent semantic digests", () => {
    const order = verifiedFixture("qrl-sign-message-v2");
    const signedIntent = signedIntentFixture(order, "qrl-sign-message-v2");
    const custom = buildFillIntentV1Payload(signedIntent.intent, {
      ...signedIntent.auth,
      scheme: "qrl-sign-message-v2",
    });
    const official = buildFillIntentV1Payload(signedIntent.intent, {
      ...signedIntent.auth,
      scheme: "qrl-sign-message-v2",
    });
    const digest = intentDigest(signedIntent.intent, signedIntent.auth);
    expect(custom.message).toEqual(official.message);
    expect(digest).toBe(hex(sha256(protocolMessageBytes(official))));
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
    ).toBe("0x4f3673dd21bcb296e18dbaf410ea73a2a7dd0b367a72646b69646f3e31ccdd20");
    expect(() =>
      computeReleaseCommitment(
        `0x${"11".repeat(32)}`,
        `0x${"22".repeat(32)}`,
        `0x${"AA".repeat(32)}`,
      ),
    ).toThrow(/lowercase bytes32/);
  });

  for (const makerScheme of ["qrl-sign-message-v2"] as const) {
    it(`verifies intent, fill, and cancel proofs for ${makerScheme} orders`, () => {
      const order = verifiedFixture(makerScheme);
      const takerScheme =
        makerScheme === "qrl-sign-message-v2" ? "qrl-sign-message-v2" : "qrl-sign-message-v2";
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
    ["qrl-sign-message-v2", "qrl-sign-message-v2"],
    ["qrl-sign-message-v2", "qrl-sign-message-v2"],
  ] as const) {
    it(`accepts ${terminalScheme} terminal proofs for a ${orderScheme} order`, () => {
      const order = verifiedFixture(orderScheme);
      const signedIntent = signedIntentFixture(order, "qrl-sign-message-v2");
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
    const order = verifiedFixture("qrl-sign-message-v2");
    const longIntent = signedIntentFixture(order, "qrl-sign-message-v2", NOW + 122);
    expect(verifyFillIntentV1(longIntent.intent, longIntent.auth, order, NOW + 20)).toBe(false);

    const signedIntent = signedIntentFixture(order, "qrl-sign-message-v2");
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
    const order = verifiedFixture("qrl-sign-message-v2", { expiresAt: NOW + 65 });
    const signedIntent = signedIntentFixture(order, "qrl-sign-message-v2", NOW + 50);
    const signedFill = signedFillFixture(order, signedIntent, 60);

    expect(
      verifyFillV1(signedFill.fill, signedFill.auth, order, signedIntent, {
        now: NOW + 200,
        allowExpired: true,
      }),
    ).toBe(false);
  });

  it("rejects oversized FillV1 escrow windows before signing and on verification", async () => {
    const order = verifiedFixture("qrl-sign-message-v2");
    const signedIntent = signedIntentFixture(order, "qrl-sign-message-v2");
    const multiYear = signedFillFixture(order, signedIntent, 60, {
      initiatorTimeout: NOW + 10 * 365 * 24 * 3600,
    });
    expect(verifyFillV1(multiYear.fill, multiYear.auth, order, signedIntent, NOW + 20)).toBe(
      false,
    );

    const makerRequest = walletRequest("qrl-sign-message-v2", testSigner(9));
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
