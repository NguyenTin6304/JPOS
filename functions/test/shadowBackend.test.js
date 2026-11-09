/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const test = require("node:test");
const logger = require("firebase-functions/logger");
const {
  SHADOW_TIMEOUT_MS,
  buildShadowOrderCommand,
  sendShadowOrder,
  sendShadowPayment,
} = require("../lib/services/shadowBackend");

const TOKEN = "k".repeat(43);
const TOKENS = JSON.stringify({ w1: TOKEN, w2: "o".repeat(43) });
const input = {
  localOrderId: "ORD-1761534000000-ABC123",
  shopId: 7,
  warehouseId: "w1",
  deviceId: "pos-1",
  voucherCodes: [],
};
const items = [
  { goodsId: "g1", goodsName: "Vé", price: 90000, quantity: 2, ticketsPerUnit: 0 },
];
const operator = { employeeId: "E1", firebaseUid: "cashier-1", name: "Thu ngân giả" };
const order = {
  createdAt: "2026-10-27T03:00:00.000Z",
  updatedAt: "2026-10-27T03:02:00.000Z",
  invoiceRequestToken: "A".repeat(43),
  invoiceRequestCreatedAt: "2026-10-27T03:00:00.000Z",
  paymentMethodId: "CASH",
  paidAt: "2026-10-27T03:02:00.000Z",
};

/**
 * Run `body` with a fake fetch, env and logger; restore everything afterwards.
 * `url` or `tokens` set to null means the variable is not set at all.
 */
async function withFakes({ url = "https://api.example.test/", tokens = TOKENS, respond }, body) {
  const saved = {
    fetch: global.fetch,
    warn: logger.warn,
    url: process.env.SHADOW_BACKEND_URL,
    tokens: process.env.SHADOW_STORE_TOKENS,
  };
  const calls = [];
  const warnings = [];
  global.fetch = async (target, init) => {
    calls.push({ target, init });
    return respond(target, init);
  };
  logger.warn = (...args) => warnings.push(args);
  if (url === null) delete process.env.SHADOW_BACKEND_URL;
  else process.env.SHADOW_BACKEND_URL = url;
  if (tokens === null) delete process.env.SHADOW_STORE_TOKENS;
  else process.env.SHADOW_STORE_TOKENS = tokens;
  try {
    await body({ calls, warnings });
  } finally {
    global.fetch = saved.fetch;
    logger.warn = saved.warn;
    if (saved.url === undefined) delete process.env.SHADOW_BACKEND_URL;
    else process.env.SHADOW_BACKEND_URL = saved.url;
    if (saved.tokens === undefined) delete process.env.SHADOW_STORE_TOKENS;
    else process.env.SHADOW_STORE_TOKENS = saved.tokens;
  }
}

const ok = (body = { result: "applied", reason: null }) => async () =>
  new Response(JSON.stringify(body), { status: 200 });

test("prepare command carries the input, priced items and generated values", () => {
  const command = buildShadowOrderCommand(
    "prepare",
    { ...input, uid: "m1", member: { uid: "m1", memberCode: null, fullName: "Khách", phone: "0900", levelName: "Bạc" } },
    items,
    { ...operator, extra: "ignored" },
    order,
  );

  assert.deepEqual(Object.keys(command), [
    "localOrderId", "shopId", "warehouseId", "uid", "member", "deviceId", "voucherCodes", "items",
    "operator", "createdAt", "invoiceRequestToken", "invoiceRequestCreatedAt", "updatedAt",
  ]);
  assert.deepEqual(command.operator, operator);
  assert.equal(command.updatedAt, order.updatedAt);
  assert.equal(command.items, items);
});

test("checkout command sends the payment method and paidAt instead of updatedAt", () => {
  const command = buildShadowOrderCommand("checkout", { ...input, deviceId: undefined }, items, operator, order);

  assert.equal(command.paymentMethodId, "CASH");
  assert.equal(command.paidAt, order.paidAt);
  assert.equal("updatedAt" in command, false);
  assert.equal("deviceId" in command, false);
  assert.equal("uid" in command || "member" in command, false);
});

test("nothing is sent until the backend URL and the store token are configured", async () => {
  const settingsList = [
    { url: null },
    { url: "  " },
    { tokens: null },
    { tokens: JSON.stringify({ other: TOKEN }) },
    { tokens: "not json" },
    { tokens: "[]" },
    { tokens: JSON.stringify({ w1: 7 }) },
  ];
  for (const settings of settingsList) {
    await withFakes({ ...settings, respond: ok() }, async ({ calls }) => {
      await sendShadowOrder("prepare", { localOrderId: input.localOrderId, warehouseId: "w1" });
      assert.equal(calls.length, 0);
    });
  }
});

test("the command is posted with the token of its store and a short timeout", async () => {
  await withFakes({ respond: ok() }, async ({ calls, warnings }) => {
    const command = buildShadowOrderCommand("checkout", input, items, operator, order);

    await sendShadowOrder("checkout", command);

    assert.equal(calls.length, 1);
    const { target, init } = calls[0];
    assert.equal(target, "https://api.example.test/shadow/pos-orders/checkout");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["X-Store-Token"], TOKEN);
    assert.deepEqual(JSON.parse(init.body), JSON.parse(JSON.stringify(command)));
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(SHADOW_TIMEOUT_MS, 2000);
    assert.equal(warnings.length, 0);
  });
});

test("each store sends its own token", async () => {
  await withFakes({ respond: ok() }, async ({ calls }) => {
    const command = buildShadowOrderCommand("prepare", { ...input, warehouseId: "w2" }, items, operator, order);

    await sendShadowOrder("prepare", command);

    assert.equal(calls[0].init.headers["X-Store-Token"], "o".repeat(43));
  });
});

test("a store without a token is reported, and no token appears in the log", async () => {
  await withFakes({ tokens: JSON.stringify({ w2: TOKEN }), respond: ok() }, async ({ calls, warnings }) => {
    await sendShadowOrder("prepare", buildShadowOrderCommand("prepare", input, items, operator, order));

    assert.equal(calls.length, 0);
    assert.deepEqual(warnings[0][1], { operation: "prepare", localOrderId: input.localOrderId, warehouseId: "w1" });
    assert.equal(JSON.stringify(warnings).includes(TOKEN), false);
  });
});

test("a broken secret never throws and its content is not logged", async () => {
  await withFakes({ tokens: `not json ${TOKEN}`, respond: ok() }, async ({ calls, warnings }) => {
    await sendShadowOrder("prepare", buildShadowOrderCommand("prepare", input, items, operator, order));

    assert.equal(calls.length, 0);
    assert.deepEqual(warnings[0][1], { operation: "prepare", localOrderId: input.localOrderId, error: "SyntaxError" });
    assert.equal(JSON.stringify(warnings).includes(TOKEN), false);
  });
});

test("backend errors, rejections and network failures never throw", async () => {
  const cases = [
    async () => new Response("", { status: 503 }),
    ok({ result: "rejected", reason: "qr-needs-payos" }),
    async () => { throw new TypeError("fetch failed"); },
    async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
    async () => new Response("not json", { status: 200 }),
  ];
  for (const respond of cases) {
    await withFakes({ respond }, async ({ warnings }) => {
      await sendShadowOrder("prepare", buildShadowOrderCommand("prepare", input, items, operator, order));
      assert.equal(warnings.length, 1);
    });
  }
});

test("a QR payment command goes to the payment path and cannot overwrite the order reference", async () => {
  await withFakes({ respond: ok() }, async ({ calls }) => {
    await sendShadowPayment(
      "payos-status",
      { localOrderId: input.localOrderId, warehouseId: "w1" },
      { operation: "other", warehouseId: "w2", orderCode: 1 },
    );

    const { target, init } = calls[0];
    assert.equal(target, "https://api.example.test/shadow/pos-orders/payment");
    assert.equal(init.headers["X-Store-Token"], TOKEN);
    assert.deepEqual(JSON.parse(init.body), {
      operation: "payos-status",
      warehouseId: "w1",
      localOrderId: input.localOrderId,
      orderCode: 1,
    });
  });
});

test("a failed QR payment command never throws and logs no order data", async () => {
  await withFakes({ respond: async () => { throw new TypeError("fetch failed"); } }, async ({ warnings }) => {
    await sendShadowPayment(
      "payos-link",
      { localOrderId: input.localOrderId, warehouseId: "w1" },
      { link: { accountName: "CONG TY GIA" } },
    );

    assert.deepEqual(warnings[0][1], { operation: "payos-link", localOrderId: input.localOrderId, error: "TypeError" });
    assert.equal(JSON.stringify(warnings).includes("CONG TY GIA"), false);
  });
});

test("logs carry only the operation, order id and an error code, never order data", async () => {
  await withFakes({ respond: async () => { throw new TypeError("fetch failed"); } }, async ({ warnings }) => {
    await sendShadowOrder("prepare", buildShadowOrderCommand("prepare", input, items, operator, order));

    const [, details] = warnings[0];
    assert.deepEqual(details, { operation: "prepare", localOrderId: input.localOrderId, error: "TypeError" });
    assert.equal(JSON.stringify(warnings).includes(operator.name), false);
    assert.equal(JSON.stringify(warnings).includes(TOKEN), false);
  });
});
