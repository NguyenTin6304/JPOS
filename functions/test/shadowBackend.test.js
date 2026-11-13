/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const test = require("node:test");
const logger = require("firebase-functions/logger");
const adminFunctions = require("firebase-admin/functions");
const {
  SHADOW_QUEUE_MAX_ATTEMPTS,
  SHADOW_QUEUE_TIMEOUT_MS,
  SHADOW_TIMEOUT_MS,
  buildShadowOrderCommand,
  handleShadowTask,
  sendShadowOrder,
  sendShadowPayment,
  shadowAppliedVouchers,
  shadowReleasedVouchers,
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
    error: logger.error,
    url: process.env.SHADOW_BACKEND_URL,
    tokens: process.env.SHADOW_STORE_TOKENS,
  };
  const calls = [];
  const warnings = [];
  const errors = [];
  global.fetch = async (target, init) => {
    calls.push({ target, init });
    return respond(target, init);
  };
  logger.warn = (...args) => warnings.push(args);
  logger.error = (...args) => errors.push(args);
  if (url === null) delete process.env.SHADOW_BACKEND_URL;
  else process.env.SHADOW_BACKEND_URL = url;
  if (tokens === null) delete process.env.SHADOW_STORE_TOKENS;
  else process.env.SHADOW_STORE_TOKENS = tokens;
  try {
    await body({ calls, warnings, errors });
  } finally {
    global.fetch = saved.fetch;
    logger.warn = saved.warn;
    logger.error = saved.error;
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
  assert.equal("vouchers" in command, false);
});

const applied = {
  subtotalAmount: 180000,
  discountAmount: 90000,
  totalAmount: 90000,
  vouchers: [{
    code: "FREE-0001",
    campaignId: "c1",
    campaignName: "Tặng vé",
    rewardType: "FREE_TICKET",
    rewardValue: 0,
    product: { goodsId: "g1", goodsName: "Vé", price: 90000, quantity: 1 },
    discountAmount: 90000,
  }],
  appliedAt: new Date("2026-10-27T03:02:00.004Z"),
};

test("a checkout with vouchers sends the lookups without the discounts, and when they were written", () => {
  const command = buildShadowOrderCommand(
    "checkout", { ...input, voucherCodes: ["FREE-0001"] }, items, operator, order, applied,
  );

  const lookup = { ...applied.vouchers[0] };
  delete lookup.discountAmount;
  assert.deepEqual(command.vouchers, [lookup]);
  assert.equal(command.vouchersAppliedAt, "2026-10-27T03:02:00.004Z");
});

test("writes that touch no voucher add nothing to the command", () => {
  assert.deepEqual(shadowAppliedVouchers(null), {});
  assert.deepEqual(shadowAppliedVouchers({ ...applied, vouchers: [] }), {});
  assert.deepEqual(shadowReleasedVouchers({ codes: [], releasedAt: new Date() }), {});
  assert.deepEqual(
    shadowReleasedVouchers({ codes: ["FREE-0001"], releasedAt: new Date("2026-10-27T03:05:00.000Z") }),
    { voucherRelease: { codes: ["FREE-0001"], releasedAt: "2026-10-27T03:05:00.000Z" } },
  );
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

// --- previousUpdatedAt and queued delivery (SHADOW_DELIVERY=queue) ---

const BEFORE = "2026-10-27T03:00:00.000Z";
const orderRef = { localOrderId: input.localOrderId, warehouseId: "w1" };

/** Run `body` with SHADOW_DELIVERY=queue and a fake Cloud Tasks queue. `enqueue` may throw. */
async function withQueue(enqueue, body) {
  const saved = { getFunctions: adminFunctions.getFunctions, delivery: process.env.SHADOW_DELIVERY };
  const queued = [];
  adminFunctions.getFunctions = () => ({
    taskQueue: (name) => ({
      enqueue: async (data, options) => {
        queued.push({ name, data, options });
        if (enqueue) await enqueue(data, options);
      },
    }),
  });
  process.env.SHADOW_DELIVERY = "queue";
  try {
    await body({ queued });
  } finally {
    adminFunctions.getFunctions = saved.getFunctions;
    if (saved.delivery === undefined) delete process.env.SHADOW_DELIVERY;
    else process.env.SHADOW_DELIVERY = saved.delivery;
  }
}

const queuedCheckout = (overrides = {}) => ({
  path: "checkout",
  operation: "checkout",
  command: buildShadowOrderCommand("checkout", input, items, operator, order, null, BEFORE),
  ...overrides,
});

test("commands carry the order's updatedAt before the write, null when the write created the order", async () => {
  assert.equal(buildShadowOrderCommand("prepare", input, items, operator, order, null, null).previousUpdatedAt, null);
  assert.equal(buildShadowOrderCommand("checkout", input, items, operator, order, applied, BEFORE).previousUpdatedAt, BEFORE);
  // Callers that do not order their commands leave it out.
  assert.equal("previousUpdatedAt" in buildShadowOrderCommand("prepare", input, items, operator, order), false);

  await withFakes({ respond: ok() }, async ({ calls }) => {
    await sendShadowPayment("payos-status", orderRef, { orderCode: 1 }, BEFORE);
    await sendShadowPayment("qr-stage", orderRef, { updatedAt: BEFORE }, null);
    await sendShadowPayment("payos-status", orderRef, { orderCode: 1 });

    const bodies = calls.map((call) => JSON.parse(call.init.body));
    assert.equal(bodies[0].previousUpdatedAt, BEFORE);
    assert.equal(bodies[1].previousUpdatedAt, null);
    assert.equal("previousUpdatedAt" in bodies[2], false);
  });
});

test("with queued delivery the command goes to the task queue and the sale does not wait for the backend", async () => {
  await withFakes({ respond: ok() }, async ({ calls, warnings }) => {
    await withQueue(null, async ({ queued }) => {
      const command = buildShadowOrderCommand("checkout", input, items, operator, order, null, BEFORE);

      await sendShadowOrder("checkout", command);
      await sendShadowPayment("payos-status", orderRef, { orderCode: 1 }, BEFORE);

      assert.equal(calls.length, 0);
      assert.deepEqual(queued.map((item) => item.name), [
        "locations/asia-southeast1/functions/deliverShadowCommand",
        "locations/asia-southeast1/functions/deliverShadowCommand",
      ]);
      assert.deepEqual(queued[0].data, { path: "checkout", operation: "checkout", command });
      assert.deepEqual(queued[0].options, { dispatchDeadlineSeconds: 30 });
      assert.equal(queued[1].data.path, "payment");
      assert.equal(queued[1].data.command.previousUpdatedAt, BEFORE);
      // The store token stays in the secret: the worker adds it.
      assert.equal(JSON.stringify(queued).includes(TOKEN), false);
      assert.equal(warnings.length, 0);
    });
  });
});

test("a command that cannot be queued is posted directly", async () => {
  const denied = Object.assign(new Error("denied"), { name: "FirebaseFunctionsError" });
  await withFakes({ respond: ok() }, async ({ calls, warnings }) => {
    await withQueue(async () => { throw denied; }, async ({ queued }) => {
      await sendShadowOrder("prepare", buildShadowOrderCommand("prepare", input, items, operator, order, null, null));

      assert.equal(queued.length, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].target, "https://api.example.test/shadow/pos-orders/prepare");
      assert.deepEqual(warnings[0][1], {
        operation: "prepare",
        localOrderId: input.localOrderId,
        error: "FirebaseFunctionsError",
      });
    });
  });
});

test("nothing is queued until the backend URL is configured", async () => {
  await withFakes({ url: null, respond: ok() }, async ({ calls }) => {
    await withQueue(null, async ({ queued }) => {
      await sendShadowOrder("prepare", buildShadowOrderCommand("prepare", input, items, operator, order, null, null));

      assert.equal(queued.length, 0);
      assert.equal(calls.length, 0);
    });
  });
});

test("the worker posts a queued command with a longer timeout and is done once the backend received it", async () => {
  const answers = [
    ok(),
    ok({ result: "duplicate", reason: null }),
    ok({ result: "stale", reason: null }),
    ok({ result: "rejected", reason: "qr-needs-payos" }),
  ];
  for (const respond of answers) {
    await withFakes({ respond }, async ({ calls }) => {
      await handleShadowTask(queuedCheckout(), 0);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].target, "https://api.example.test/shadow/pos-orders/checkout");
      assert.equal(calls[0].init.headers["X-Store-Token"], TOKEN);
      assert.equal(JSON.parse(calls[0].init.body).previousUpdatedAt, BEFORE);
      assert.ok(calls[0].init.signal instanceof AbortSignal);
    });
  }
  assert.equal(SHADOW_QUEUE_TIMEOUT_MS, 10000);
});

test("the worker asks Cloud Tasks to retry while the backend is down, busy or waiting for the write before", async () => {
  const answers = [
    async () => new Response(JSON.stringify({ result: "deferred", reason: "predecessor-missing" }), { status: 409 }),
    async () => new Response("", { status: 429 }),
    async () => new Response("", { status: 500 }),
    async () => new Response("", { status: 502 }),
    async () => new Response("", { status: 503 }),
    async () => { throw new TypeError("fetch failed"); },
    async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
  ];
  for (const respond of answers) {
    await withFakes({ respond }, async ({ warnings, errors }) => {
      await assert.rejects(handleShadowTask(queuedCheckout(), 0));

      assert.equal(warnings.length, 1);
      assert.equal(errors.length, 0);
      assert.equal(JSON.stringify(warnings).includes(TOKEN), false);
      assert.equal(JSON.stringify(warnings).includes(operator.name), false);
    });
  }
});

test("the worker drops a command that sending again cannot help", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    await withFakes({ respond: async () => new Response("", { status }) }, async ({ calls, warnings }) => {
      await handleShadowTask(queuedCheckout(), 0);

      assert.equal(calls.length, 1);
      assert.deepEqual(warnings[0][1], { operation: "checkout", localOrderId: input.localOrderId, status });
    });
  }
  for (const tokens of [JSON.stringify({ w2: TOKEN }), `not json ${TOKEN}`]) {
    await withFakes({ tokens, respond: ok() }, async ({ calls, warnings }) => {
      await handleShadowTask(queuedCheckout(), 0);

      assert.equal(calls.length, 0);
      assert.equal(warnings.length, 1);
      assert.equal(JSON.stringify(warnings).includes(TOKEN), false);
    });
  }
});

test("on the last try the worker logs the command as dropped instead of asking for a retry", async () => {
  await withFakes({ respond: async () => new Response("", { status: 503 }) }, async ({ errors }) => {
    await assert.rejects(handleShadowTask(queuedCheckout(), SHADOW_QUEUE_MAX_ATTEMPTS - 2));
    assert.equal(errors.length, 0);

    await handleShadowTask(queuedCheckout(), SHADOW_QUEUE_MAX_ATTEMPTS - 1);

    assert.deepEqual(errors[0][1], {
      operation: "checkout",
      localOrderId: input.localOrderId,
      attempts: SHADOW_QUEUE_MAX_ATTEMPTS,
    });
  });
});

test("the worker ignores a task that is not a shadow command", async () => {
  await withFakes({ respond: ok() }, async ({ calls, errors }) => {
    const malformed = [
      null,
      {},
      queuedCheckout({ path: "../admin" }),
      queuedCheckout({ operation: 7 }),
      queuedCheckout({ command: null }),
    ];
    for (const task of malformed) {
      await handleShadowTask(task, 0);
    }

    assert.equal(calls.length, 0);
    assert.equal(errors.length, malformed.length);
  });
});

test("the queue worker retries for about 1.5 hours, one command at a time, under the backend rate limit", () => {
  const savedProject = process.env.GCLOUD_PROJECT;
  const worker = require.resolve("../lib/order/shadowDeliveryWorker");
  process.env.GCLOUD_PROJECT = "test-jw-system";
  delete require.cache[worker];
  try {
    const endpoint = require(worker).deliverShadowCommand.__endpoint;
    const { retryConfig, rateLimits, invoker } = endpoint.taskQueueTrigger;

    assert.deepEqual(endpoint.region, ["asia-southeast1"]);
    assert.equal(retryConfig.maxAttempts, SHADOW_QUEUE_MAX_ATTEMPTS);
    // Cloud Tasks waits minBackoff, doubles the wait maxDoublings times, then adds
    // 2^maxDoublings * minBackoff each time, capped at maxBackoff:
    // 10, 20, 40, 80, 160, 320 s, then 10 min. 14 waits between 15 tries.
    const waits = [];
    let wait = retryConfig.minBackoffSeconds;
    for (let retry = 0; retry < retryConfig.maxAttempts - 1; retry += 1) {
      waits.push(Math.min(wait, retryConfig.maxBackoffSeconds));
      wait = retry < retryConfig.maxDoublings
        ? wait * 2
        : wait + retryConfig.minBackoffSeconds * 2 ** retryConfig.maxDoublings;
    }
    assert.deepEqual(waits.slice(0, 7), [10, 20, 40, 80, 160, 320, 600]);
    const minutes = waits.reduce((sum, seconds) => sum + seconds, 0) / 60;
    assert.ok(minutes > 80 && minutes < 100, `${minutes} minutes`);
    assert.deepEqual(rateLimits, { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 5 });
    // On test the order functions run as the QA account: its OIDC token calls the worker.
    assert.deepEqual(invoker, ["pos-payment-qa@test-jw-system.iam.gserviceaccount.com"]);
    assert.equal(endpoint.serviceAccountEmail, "pos-payment-qa@test-jw-system.iam.gserviceaccount.com");
    assert.deepEqual(endpoint.secretEnvironmentVariables.map((secret) => secret.key), ["SHADOW_STORE_TOKENS"]);
  } finally {
    delete require.cache[worker];
    if (savedProject === undefined) delete process.env.GCLOUD_PROJECT;
    else process.env.GCLOUD_PROJECT = savedProject;
  }
});
