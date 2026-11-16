/* eslint-disable @typescript-eslint/no-require-imports */
// Runs the real QR payment and voucher code on an in-memory Firestore and a fake
// PayOS, and records every shadow command together with the order and the
// voucher redemptions as Firestore holds them at that moment. With
// SHADOW_FIXTURE_OUT set, the recording is written to a file: the JJL Data Sync
// backend replays it and must rebuild the documents at every step.
// All data here is made up. No network, no Firestore, no PayOS.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { ConnectionError } = require("@payos/node");
const { db } = require("../lib/config/firebase");
const auth = require("../lib/services/posAuthService");
const payosService = require("../lib/services/payosService");
const {
  cancelPayOSPaymentForUser,
  confirmPayOSPaymentManuallyForUser,
  createPayOSPaymentForUser,
  getPayOSPaymentStatusForUser,
  handlePayOSPaymentTimeoutForUser,
  recreatePayOSPaymentForUser,
  resumePayOSPaymentForUser,
} = require("../lib/payment/payosFunctions");
const {
  handlePayOSReconciliation,
  reconcilePendingPayOSPayments,
} = require("../lib/payment/payosReconciliation");
const { payosWebhook } = require("../lib/payment/payosWebhook");
const { createPaymentWatch } = require("../lib/payment/paymentStatusProjection");
const {
  checkoutPosOrderForUser,
  getPosOrderForUser,
  onOrderLocalPaid,
  preparePosOrderForUser,
  retryFailedOrderSyncs,
  retryPosOrderSyncForUser,
} = require("../lib/order/functions");
const { runShadowedTransaction } = require("../lib/services/shadowTransaction");

const USER = "cashier-1";
const OPERATOR_NAME = "Thu ngân giả";
const WAREHOUSE = "w1";
const WAREHOUSE_CODE = "LM81";
const DEVICE = "pos-1";
const SHOP = 7;
const device = { id: DEVICE, warehouseId: WAREHOUSE, paymentLatencyOptimizationEnabled: false };
const START = Date.parse("2026-11-09T02:00:00.000Z");
const MINUTE = 60_000;

// Every reading of the clock moves it by 1 ms, as on a real machine, so a backend
// rule that assumes two separately taken timestamps are equal fails here.
const RealDate = Date;
let clockMs = START;
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) {
      clockMs += 1;
      super(clockMs);
    } else {
      super(...args);
    }
  }

  static now() {
    clockMs += 1;
    return clockMs;
  }
}
const tick = (ms) => { clockMs += ms; };

let store;
let steps;
let initial;
let unmirroredWrites;
let writeWithoutCommand;
let allowTwoWritesPerCommand;
let orderId;
let payos;
let hk;
let scenarioCount = 0;
const recordings = [];

function assertNoUndefined(value, path = "") {
  // Firestore refuses undefined values, and JPOS does not set ignoreUndefinedProperties.
  assert.notEqual(value, undefined, `undefined value at ${path}`);
  if (Array.isArray(value)) value.forEach((item, index) => assertNoUndefined(item, `${path}.${index}`));
  else if (value && value.constructor === Object) {
    Object.entries(value).forEach(([key, item]) => assertNoUndefined(item, `${path}.${key}`));
  }
}

function setPath(document, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  let target = document;
  for (const key of keys) {
    target[key] ??= {};
    target = target[key];
  }
  if (value && value.constructor.name === "ArrayUnionTransform") {
    target[last] = [...new Set([...(target[last] ?? []), ...value.elements])];
  } else if (value && value.constructor.name === "NumericIncrementTransform") {
    target[last] = (target[last] ?? 0) + value.operand;
  } else {
    target[last] = structuredClone(value);
  }
}

function applyWrite({ ref, kind, value }) {
  assertNoUndefined(kind === "update"
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item?.elements ?? item]))
    : value);
  if (kind === "set") {
    store.set(ref.path, structuredClone(value));
  } else if (kind === "merge") {
    store.set(ref.path, { ...(store.get(ref.path) ?? {}), ...structuredClone(value) });
  } else {
    const document = structuredClone(store.get(ref.path));
    for (const [path, item] of Object.entries(value)) setPath(document, path, item);
    store.set(ref.path, document);
  }
  if (ref.path.startsWith("pos_orders/")) {
    if (unmirroredWrites > 0 && !allowTwoWritesPerCommand) writeWithoutCommand = true;
    unmirroredWrites += 1;
  }
}

function snapshotOf(ref) {
  const value = store.get(ref.path);
  return {
    exists: value !== undefined,
    id: ref.id,
    ref,
    data: () => (value === undefined ? undefined : structuredClone(value)),
  };
}

class Ref {
  constructor(path) {
    this.path = path;
    this.id = path.split("/").pop();
  }

  async get() {
    return snapshotOf(this);
  }

  async update(value) {
    applyWrite({ ref: this, kind: "update", value });
  }

  async create(value) {
    if (store.has(this.path)) throw Object.assign(new Error("Document already exists"), { code: 6 });
    applyWrite({ ref: this, kind: "set", value });
  }
}

const readPath = (document, path) => path.split(".").reduce((value, key) => value?.[key], document);

class Query {
  constructor(collection, parts = {}) {
    this.collection = collection;
    this.parts = { filters: [], ...parts };
  }

  with(parts) {
    return new Query(this.collection, { ...this.parts, ...parts });
  }

  doc(id) {
    return new Ref(`${this.collection}/${id}`);
  }

  where(field, operator, expected) {
    const matches = (value) => {
      if (operator === "array-contains") return Array.isArray(value) && value.includes(expected);
      if (operator === "==") return value === expected;
      if (value === undefined || value === null) return false;
      if (operator === "<=") return value <= expected;
      if (operator === "<") return value < expected;
      if (operator === ">=") return value >= expected;
      throw new Error(`Unsupported operator ${operator}`);
    };
    const filter = (document) => matches(readPath(document, field));
    return this.with({ filters: [...this.parts.filters, filter] });
  }

  orderBy(field) {
    return this.with({ orderField: field });
  }

  limit(count) {
    return this.with({ limitCount: count });
  }

  startAfter(snapshot) {
    return this.with({ afterId: snapshot.id });
  }

  async get() {
    const { filters, orderField, limitCount, afterId } = this.parts;
    let rows = [...store.entries()]
      .filter(([path]) => path.startsWith(`${this.collection}/`))
      .filter(([, document]) => filters.every((filter) => filter(document)));
    if (orderField) {
      rows.sort(([, a], [, b]) => String(readPath(a, orderField)).localeCompare(String(readPath(b, orderField))));
    }
    if (afterId) {
      const index = rows.findIndex(([path]) => path.endsWith(`/${afterId}`));
      rows = rows.slice(index + 1);
    }
    if (limitCount) rows = rows.slice(0, limitCount);
    const docs = rows.map(([path]) => snapshotOf(new Ref(path)));
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

function fakePayOS() {
  const find = (idOrCode) => [...payos.links.values()].find(
    (link) => link.id === idOrCode || link.orderCode === idOrCode,
  );
  return {
    webhooks: { verify: async (body) => body.data },
    paymentRequests: {
      create: async (request) => {
        if (payos.createError) throw payos.createError;
        payos.links.set(request.orderCode, {
          id: `link-${request.orderCode}`,
          orderCode: request.orderCode,
          status: "PENDING",
          amount: request.amount,
          amountPaid: 0,
          transactions: [],
        });
        // The cashier may act while PayOS is still creating the QR.
        if (payos.whileCreating) await payos.whileCreating();
        return {
          bin: "970422",
          accountNumber: "0123456789",
          accountName: "CONG TY GIA",
          amount: request.amount,
          description: request.description,
          orderCode: request.orderCode,
          currency: "VND",
          paymentLinkId: `link-${request.orderCode}`,
          status: "PENDING",
          expiredAt: request.expiredAt,
          checkoutUrl: `https://pay.example.test/${request.orderCode}`,
          qrCode: payos.noQr ? "" : `qr-${request.orderCode}`,
        };
      },
      get: async (orderCode) => {
        if (payos.getError) throw payos.getError;
        return structuredClone(find(orderCode));
      },
      cancel: async (idOrCode) => {
        if (payos.cancelError) throw payos.cancelError;
        const link = find(idOrCode);
        if (link.status !== "PAID") link.status = "CANCELLED";
        return structuredClone(link);
      },
    },
  };
}

function reset() {
  scenarioCount += 1;
  const number = String(scenarioCount).padStart(4, "0");
  orderId = `ORD-179430000${number}-QR${number}`;
  clockMs = START;
  steps = [];
  initial = null;
  unmirroredWrites = 0;
  writeWithoutCommand = false;
  allowTwoWritesPerCommand = false;
  payos = { links: new Map() };
  hk = { orders: new Map(), script: {}, calls: [], created: 0 };
  store = new Map([
    ["jpos_products/vé", { goodsName: "Vé test", price: 222, afterTaxPrice: 222, taxRate: 8, taxRateType: 1, category: 0 }],
    ["jpos_products/combo", {
      goodsName: "Vé combo", price: 90000, afterTaxPrice: 100000, taxRate: 10, taxRateType: 1, category: 1, ticketsPerUnit: 1,
    }],
    ["jpos_products/nước", { goodsName: "Nước giả", price: 15, afterTaxPrice: 15, taxRate: 8, taxRateType: 1, category: 0 }],
  ]);
  saveVouchers();
}

// JPULSE marketing campaigns, their codes, and the store settings that map each
// campaign to a product (pos_voucher_campaign_settings).
const CAMPAIGNS = {
  "c-free": { name: "Tặng vé giả", rewardValue: 0, productId: "vé" },
  "c-item": { name: "Tặng combo giả", rewardValue: 0, productId: "combo" },
  "c-pct10": { name: "Giảm 10% giả", rewardValue: 10, productId: "nước" },
  "c-pct20": { name: "Giảm 20% giả", rewardValue: 20, productId: "combo" },
};
const VOUCHER_CODES = [
  ["FREE-0001", "c-free", "FREE_TICKET", "AVAILABLE"],
  ["FREE-0002", "c-free", "FREE_TICKET", "DISTRIBUTED"],
  ["ITEM-0001", "c-item", "FREE_ITEM", "DISTRIBUTED"],
  ["PCT10-0001", "c-pct10", "DISCOUNT_PERCENT", "AVAILABLE"],
  ["PCT20-0001", "c-pct20", "DISCOUNT_PERCENT", "DISTRIBUTED"],
];

function saveVouchers() {
  for (const [id, campaign] of Object.entries(CAMPAIGNS)) {
    store.set(`marketing_voucher_campaigns/${id}`, {
      name: campaign.name,
      status: "ACTIVE",
      valid_from: "2026-11-01",
      valid_to: "2026-12-31",
      reward_value: campaign.rewardValue,
      is_deleted: false,
      code_counts: { available: 10, distributed: 10, used: 0 },
      revision: 1,
    });
    store.set(`pos_voucher_campaign_settings/${WAREHOUSE}__${id}`, {
      enabled: true,
      is_deleted: false,
      product_id: campaign.productId,
      quantity: 1,
    });
  }
  for (const [code, campaignId, rewardType, status] of VOUCHER_CODES) {
    store.set(`marketing_voucher_codes/${code}`, {
      campaign_id: campaignId,
      campaign_name: CAMPAIGNS[campaignId].name,
      reward_type: rewardType,
      // The percent codes carry no value of their own and take the campaign's.
      ...(rewardType === "DISCOUNT_PERCENT" ? {} : { reward_value: 0 }),
      status,
      is_deleted: false,
      revision: 1,
    });
  }
}

const redemptions = () => Object.fromEntries([...store]
  .filter(([path]) => path.startsWith("pos_voucher_redemptions/"))
  .map(([path, document]) => [path.split("/")[1], structuredClone(document)]));

function saveFixedTransferSettings(overrides = {}) {
  store.set(`pos_payment_settings/${DEVICE}`, {
    deviceId: DEVICE,
    warehouseId: WAREHOUSE,
    enabled: true,
    fixedTransferOnly: false,
    bankBin: "970436",
    accountNumber: "ABC123456",
    accountName: "CONG TY GIA & CO",
    version: 3,
    updatedAt: "2026-11-01T00:00:00.000Z",
    updatedByUid: "admin",
    ...overrides,
  });
}

const orderPath = () => `pos_orders/${orderId}`;
const order = () => structuredClone(store.get(orderPath()));
const reference = () => ({ localOrderId: orderId });
const currentCode = () => order().paymentDetails.currentOrderCode;
const input = (overrides = {}) => ({
  localOrderId: orderId,
  shopId: SHOP,
  warehouseId: WAREHOUSE,
  deviceId: DEVICE,
  items: [{ goodsId: "vé", quantity: 1 }],
  voucherCodes: [],
  ...overrides,
});
const unavailable = () => new ConnectionError("PayOS is down");

const create = (overrides) => createPayOSPaymentForUser(USER, input(overrides));
const reconcile = (action) => handlePayOSReconciliation(USER, device, action, reference());

function markPaidAtPayOS(orderCode) {
  const link = payos.links.get(orderCode);
  link.status = "PAID";
  link.amountPaid = link.amount;
  link.transactions = [{ reference: `REF${orderCode}`, transactionDateTime: "2026-11-09 09:05:00" }];
  return link;
}

async function webhook(orderCode) {
  const link = markPaidAtPayOS(orderCode);
  const response = {
    on() { return this; },
    setHeader() {},
    getHeader() {},
    set() { return this; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await payosWebhook({
    method: "POST",
    headers: {},
    get: () => undefined,
    header: () => undefined,
    body: {
      data: {
        code: "00",
        desc: "success",
        orderCode,
        amount: link.amount,
        currency: "VND",
        paymentLinkId: link.id,
        reference: `REF${orderCode}`,
        transactionDateTime: "2026-11-09 09:05:00",
      },
    },
  }, response);
  assert.equal(response.code, 200);
}

/** Start the recording from the order as it is now, for states only old code can produce. */
function restartRecording() {
  initial = order();
  steps = [];
  unmirroredWrites = 0;
}

function scenario(name, body, expectedOperations) {
  test(name, async () => {
    reset();
    await body();
    assert.equal(writeWithoutCommand, false, "an order write was not followed by a shadow command");
    assert.equal(unmirroredWrites, 0, "the last order write has no shadow command");
    assert.deepEqual(steps.at(-1).documentAfter, order());
    assert.deepEqual(steps.map((step) => step.command.operation ?? step.path), expectedOperations);
    recordings.push({ name, orderId, initial, steps });
  });
}

// A fake 鲸舰 (Jingjianx) in memory: hkApiService posts its signed requests to
// HK_BASE_URL. By default an order is created, paid and then reported paid; a
// scenario scripts other answers with hk.script[action] = [answer, ...].
const HK_BASE_URL = "https://hk.example.test";

function hkDefault(action, body) {
  if (action === "order_create") {
    hk.created += 1;
    const orderNumber = `O-FAKE-${String(hk.created).padStart(4, "0")}`;
    hk.orders.set(orderNumber, { paid: false });
    return { json: { success: true, code: 0, msg: "", data: { orderNumber, totalAmount: 0, discountAmount: 0, actualPayment: 0 } } };
  }
  if (action === "order_pay") {
    const remote = hk.orders.get(body.OrderNumber);
    if (remote) remote.paid = true;
    return { json: { success: Boolean(remote), code: remote ? 0 : 404, msg: remote ? "" : "order not found", data: { orderNumber: body.OrderNumber } } };
  }
  if (action === "order_pay_query") {
    const paid = hk.orders.get(body.OrderNumber)?.paid === true;
    return {
      json: {
        success: true,
        code: 0,
        msg: paid ? "" : "unpaid",
        data: { orderNumber: body.OrderNumber, payStatus: paid ? 2 : 1, payStatusDesc: paid ? "paid" : "unpaid" },
      },
    };
  }
  throw new Error(`The fake 鲸舰 has no ${action}`);
}

async function hkFetch(init) {
  const envelope = JSON.parse(init.body);
  const body = JSON.parse(envelope.body);
  hk.calls.push({ action: envelope.action, body });
  const scripted = hk.script[envelope.action]?.shift();
  const answer = scripted ? await scripted(body) : hkDefault(envelope.action, body);
  return new Response(JSON.stringify(answer.json ?? {}), {
    status: answer.status ?? 200,
    statusText: answer.statusText ?? "",
  });
}

const savedFetch = global.fetch;
const savedSession = auth.getPosAuthSession;
const savedGetPayOS = payosService.getPayOS;
const savedDb = { collection: db.collection, runTransaction: db.runTransaction, getAll: db.getAll };

test.before(() => {
  global.Date = FakeDate;
  process.env.SHADOW_BACKEND_URL = "https://api.example.test";
  process.env.SHADOW_STORE_TOKENS = JSON.stringify({ [WAREHOUSE]: "t".repeat(43) });
  process.env.PAYOS_RETURN_URL ??= "https://return.example.test";
  db.collection = (name) => new Query(name);
  db.getAll = (...refs) => Promise.all(refs.map((ref) => ref.get()));
  db.runTransaction = async (work) => {
    const writes = [];
    const result = await work({
      get: (ref) => ref.get(),
      set: (ref, value, options) => writes.push({ ref, kind: options?.merge ? "merge" : "set", value }),
      create: (ref, value) => writes.push({ ref, kind: "set", value }),
      update: (ref, value) => writes.push({ ref, kind: "update", value }),
    });
    writes.forEach(applyWrite);
    return result;
  };
  auth.getPosAuthSession = async () => ({
    user: { employee_id: "E1", full_name: OPERATOR_NAME },
    warehouses: [{ id: WAREHOUSE, code: WAREHOUSE_CODE }],
    permissions: { global: { "*": true } },
  });
  payosService.getPayOS = fakePayOS;
  process.env.HK_API_BASE_URL = HK_BASE_URL;
  process.env.HK_API_APP_ID = "app-fake";
  process.env.HK_API_KEY = "key-fake";
  global.fetch = async (url, init) => {
    if (String(url).startsWith(HK_BASE_URL)) return hkFetch(init);
    const command = JSON.parse(init.body);
    assert.equal(init.headers["X-Store-Token"], "t".repeat(43));
    steps.push({
      path: new URL(url).pathname.split("/").pop(),
      command,
      documentAfter: structuredClone(store.get(`pos_orders/${command.localOrderId}`)),
      redemptionsAfter: redemptions(),
    });
    unmirroredWrites = 0;
    return new Response(JSON.stringify({ result: "applied", reason: null }), { status: 200 });
  };
});

test.after(() => {
  global.Date = RealDate;
  global.fetch = savedFetch;
  auth.getPosAuthSession = savedSession;
  payosService.getPayOS = savedGetPayOS;
  Object.assign(db, savedDb);
  delete process.env.SHADOW_BACKEND_URL;
  delete process.env.SHADOW_STORE_TOKENS;
  delete process.env.HK_API_BASE_URL;
  delete process.env.HK_API_APP_ID;
  delete process.env.HK_API_KEY;
  if (process.env.SHADOW_FIXTURE_OUT) {
    fs.writeFileSync(
      process.env.SHADOW_FIXTURE_OUT,
      `${JSON.stringify({ warehouseId: WAREHOUSE, scenarios: recordings }, null, 1)}\n`,
    );
  }
});

scenario("a QR paid by webhook", async () => {
  await create();
  await createPaymentWatch(USER, device, orderId);
  tick(MINUTE);
  await webhook(currentCode());
}, ["qr-stage", "payos-reserve", "payos-link", "payment-watch", "payos-paid"]);

scenario("a member and several lines, paid after a status check", async () => {
  await create({
    uid: "m1",
    member: { uid: "m1", memberCode: null, fullName: "Khách giả", phone: "0900000000", levelName: "Bạc" },
    items: [{ goodsId: "vé", quantity: 3 }, { goodsId: "combo", quantity: 2 }],
  });
  tick(MINUTE);
  markPaidAtPayOS(currentCode());
  await getPayOSPaymentStatusForUser(USER, reference());
}, ["qr-stage", "payos-reserve", "payos-link", "payos-paid"]);

scenario("a QR over a cash draft that was prepared first", async () => {
  await preparePosOrderForUser(USER, input());
  tick(MINUTE);
  await create({ items: [{ goodsId: "combo", quantity: 1 }] });
  tick(MINUTE);
  await webhook(currentCode());
}, ["prepare", "qr-stage", "payos-reserve", "payos-link", "payos-paid"]);

scenario("a QR cancelled at the POS, PayOS confirms", async () => {
  await create();
  tick(MINUTE);
  await cancelPayOSPaymentForUser(USER, reference());
}, ["qr-stage", "payos-reserve", "payos-link", "payos-status"]);

scenario("a QR cancelled while PayOS cannot be reached", async () => {
  await create();
  tick(MINUTE);
  payos.getError = unavailable();
  await cancelPayOSPaymentForUser(USER, reference());
}, ["qr-stage", "payos-reserve", "payos-link", "payos-local-cancel"]);

scenario("a QR whose cancellation request fails", async () => {
  await create();
  tick(MINUTE);
  payos.cancelError = unavailable();
  await cancelPayOSPaymentForUser(USER, reference());
}, ["qr-stage", "payos-reserve", "payos-link", "payos-local-cancel"]);

scenario("the cashier cancels while PayOS is creating the QR", async () => {
  payos.whileCreating = async () => {
    payos.whileCreating = null;
    await cancelPayOSPaymentForUser(USER, reference());
  };
  await create();
}, ["qr-stage", "payos-reserve", "payos-status"]);

scenario("a status check that cannot reach PayOS, then a processing payment", async () => {
  await create();
  tick(MINUTE);
  payos.getError = new Error("network down");
  await assert.rejects(getPayOSPaymentStatusForUser(USER, reference()));
  tick(MINUTE);
  payos.getError = null;
  await getPayOSPaymentStatusForUser(USER, reference());
  tick(MINUTE);
  payos.links.get(currentCode()).status = "PROCESSING";
  await handlePayOSPaymentTimeoutForUser(USER, reference());
}, ["qr-stage", "payos-reserve", "payos-link", "payos-connection-error", "payos-status", "payos-status"]);

scenario("the display window ends and the same QR is shown again", async () => {
  await create();
  tick(6 * MINUTE);
  await resumePayOSPaymentForUser(USER, reference());
  tick(MINUTE);
  await webhook(currentCode());
}, ["qr-stage", "payos-reserve", "payos-link", "payos-resume", "payos-paid"]);

scenario("the QR expires and a new one is created", async () => {
  await create();
  const first = currentCode();
  tick(16 * MINUTE);
  payos.links.get(first).status = "EXPIRED";
  await recreatePayOSPaymentForUser(USER, reference());
  assert.notEqual(currentCode(), first);
  tick(MINUTE);
  await webhook(currentCode());
}, ["qr-stage", "payos-reserve", "payos-link", "payos-status", "payos-reserve", "payos-link", "payos-paid"]);

scenario("an older QR is paid after a new one replaced it", async () => {
  await create();
  const first = currentCode();
  tick(MINUTE);
  await cancelPayOSPaymentForUser(USER, reference());
  tick(MINUTE);
  await recreatePayOSPaymentForUser(USER, reference());
  tick(MINUTE);
  await webhook(first);
}, [
  "qr-stage", "payos-reserve", "payos-link", "payos-status",
  "payos-reserve", "payos-link", "payos-paid", "payos-status",
]);

scenario("manual confirmation, failed checks, a warning, then PayOS confirms", async () => {
  await create();
  tick(MINUTE);
  await confirmPayOSPaymentManuallyForUser(USER, reference());
  tick(6 * MINUTE);
  await reconcile("reconcile-check");
  tick(MINUTE);
  await reconcile("reconcile-ack");
  tick(MINUTE);
  payos.getError = unavailable();
  await reconcile("reconcile-check");
  tick(MINUTE);
  payos.getError = null;
  markPaidAtPayOS(order().paymentDetails.currentOrderCode);
  await reconcile("reconcile-check");
}, [
  "qr-stage", "payos-reserve", "payos-link", "payos-manual-confirm",
  "payos-reconcile-retry", "payos-reconcile-ack", "payos-reconcile-retry", "payos-paid",
]);

scenario("manual confirmation after the QR was cancelled, checked by the schedule", async () => {
  await create();
  tick(MINUTE);
  await cancelPayOSPaymentForUser(USER, reference());
  tick(MINUTE);
  await confirmPayOSPaymentManuallyForUser(USER, reference());
  tick(6 * MINUTE);
  await reconcilePendingPayOSPayments.run({});
}, ["qr-stage", "payos-reserve", "payos-link", "payos-status", "payos-manual-confirm", "payos-reconcile-retry"]);

scenario("a webhook arrives after manual confirmation", async () => {
  await create();
  tick(MINUTE);
  await confirmPayOSPaymentManuallyForUser(USER, reference());
  tick(MINUTE);
  await webhook(currentCode());
}, ["qr-stage", "payos-reserve", "payos-link", "payos-manual-confirm", "payos-paid"]);

scenario("an old manual confirmation gets its reconciliation schedule", async () => {
  await create();
  await confirmPayOSPaymentManuallyForUser(USER, reference());
  const legacy = order();
  delete legacy.payosReconciliation;
  store.set(orderPath(), legacy);
  restartRecording();
  tick(MINUTE);
  await reconcile("reconcile-list");
}, ["payos-reconcile-init"]);

scenario("the schedule drops the check of a verified order", async () => {
  await create();
  await webhook(currentCode());
  store.set(orderPath(), {
    ...order(),
    payosReconciliation: { dueAt: "2026-11-09T01:00:00.000Z", nextCheckAt: "2026-11-09T01:00:00.000Z" },
  });
  restartRecording();
  tick(MINUTE);
  await reconcilePendingPayOSPayments.run({});
}, ["payos-reconcile-clear"]);

scenario("PayOS cannot create the QR: fixed account, confirmed by hand", async () => {
  saveFixedTransferSettings();
  payos.createError = unavailable();
  await create();
  tick(MINUTE);
  await confirmPayOSPaymentManuallyForUser(USER, reference());
}, ["qr-stage", "payos-reserve", "payos-failed", "fixed-activate", "fixed-confirm"]);

scenario("PayOS returns no QR: fixed account, then cancelled", async () => {
  saveFixedTransferSettings();
  payos.noQr = true;
  await create();
  tick(MINUTE);
  await cancelPayOSPaymentForUser(USER, reference());
}, ["qr-stage", "payos-reserve", "payos-link", "payos-status", "fixed-activate", "fixed-cancel"]);

scenario("a store that only uses its fixed account", async () => {
  saveFixedTransferSettings({ fixedTransferOnly: true, accountName: "Nguyễn Văn A ~ (Cty)" });
  await create({ items: [{ goodsId: "combo", quantity: 2 }] });
  tick(MINUTE);
  await confirmPayOSPaymentManuallyForUser(USER, reference());
}, ["qr-stage", "fixed-activate", "fixed-confirm"]);

scenario("a cancelled QR, then the customer pays cash", async () => {
  allowTwoWritesPerCommand = true;
  await create();
  tick(MINUTE);
  await cancelPayOSPaymentForUser(USER, reference());
  tick(MINUTE);
  await checkoutPosOrderForUser(USER, { ...input(), paymentMethodId: "CASH" });
}, ["qr-stage", "payos-reserve", "payos-link", "payos-status", "checkout"]);

// --- Vouchers (round 3). Prices: vé 222, combo 100000, nước 15. ---

const cash = (overrides) => checkoutPosOrderForUser(USER, { ...input(overrides), paymentMethodId: "CASH" });

scenario("cash: a free ticket voucher", async () => {
  await cash({ items: [{ goodsId: "vé", quantity: 2 }], voucherCodes: ["free-0001"] });
}, ["checkout"]);

scenario("cash over a prepared draft: a free item and a percent rounded half up", async () => {
  // 10% of 45 is 4.5: JavaScript rounds it to 5.
  const order = { items: [{ goodsId: "nước", quantity: 3 }, { goodsId: "combo", quantity: 1 }], voucherCodes: ["ITEM-0001", "PCT10-0001"] };
  await preparePosOrderForUser(USER, input(order));
  tick(MINUTE);
  await cash(order);
}, ["prepare", "checkout"]);

scenario("cash: two free tickets cover the whole order", async () => {
  await cash({ items: [{ goodsId: "vé", quantity: 2 }], voucherCodes: ["FREE-0001", "FREE-0002"] });
}, ["checkout"]);

scenario("QR with a percent voucher, paid by webhook", async () => {
  await create({ items: [{ goodsId: "vé", quantity: 2 }, { goodsId: "combo", quantity: 1 }], voucherCodes: ["PCT20-0001"] });
  tick(MINUTE);
  await webhook(currentCode());
}, ["qr-stage", "payos-reserve", "payos-link", "payos-paid"]);

scenario("QR with a free ticket and a percent voucher, paid after a status check", async () => {
  await create({
    items: [{ goodsId: "vé", quantity: 2 }, { goodsId: "combo", quantity: 1 }],
    voucherCodes: ["FREE-0002", "PCT20-0001"],
  });
  tick(MINUTE);
  markPaidAtPayOS(currentCode());
  await getPayOSPaymentStatusForUser(USER, reference());
}, ["qr-stage", "payos-reserve", "payos-link", "payos-paid"]);

scenario("QR with a voucher cancelled at the POS, then paid in cash", async () => {
  const order = { items: [{ goodsId: "vé", quantity: 2 }], voucherCodes: ["FREE-0001"] };
  await create(order);
  tick(MINUTE);
  await cancelPayOSPaymentForUser(USER, reference());
  tick(MINUTE);
  await cash(order);
}, ["qr-stage", "payos-reserve", "payos-link", "payos-status", "checkout"]);

scenario("QR with a voucher, PayOS unreachable: released at the POS", async () => {
  await create({ items: [{ goodsId: "vé", quantity: 2 }], voucherCodes: ["FREE-0002"] });
  tick(MINUTE);
  payos.getError = unavailable();
  await cancelPayOSPaymentForUser(USER, reference());
}, ["qr-stage", "payos-reserve", "payos-link", "payos-local-cancel"]);

scenario("QR with a voucher confirmed by hand", async () => {
  await create({ items: [{ goodsId: "combo", quantity: 2 }], voucherCodes: ["ITEM-0001"] });
  tick(MINUTE);
  await confirmPayOSPaymentManuallyForUser(USER, reference());
}, ["qr-stage", "payos-reserve", "payos-link", "payos-manual-confirm"]);

scenario("QR with a voucher expires, the new QR is paid", async () => {
  // The expiry releases the reservation, so the payment redeems the voucher afresh.
  await create({ items: [{ goodsId: "vé", quantity: 3 }], voucherCodes: ["FREE-0001"] });
  const first = currentCode();
  tick(16 * MINUTE);
  payos.links.get(first).status = "EXPIRED";
  await recreatePayOSPaymentForUser(USER, reference());
  tick(MINUTE);
  await webhook(currentCode());
}, ["qr-stage", "payos-reserve", "payos-link", "payos-status", "payos-reserve", "payos-link", "payos-paid"]);

scenario("fixed account with a voucher, confirmed by hand", async () => {
  saveFixedTransferSettings();
  payos.createError = unavailable();
  await create({ items: [{ goodsId: "vé", quantity: 2 }], voucherCodes: ["FREE-0001"] });
  tick(MINUTE);
  await confirmPayOSPaymentManuallyForUser(USER, reference());
}, ["qr-stage", "payos-reserve", "payos-failed", "fixed-activate", "fixed-confirm"]);

scenario("fixed account only, with a voucher, cancelled", async () => {
  saveFixedTransferSettings({ fixedTransferOnly: true });
  await create({ items: [{ goodsId: "vé", quantity: 2 }], voucherCodes: ["FREE-0001"] });
  tick(MINUTE);
  await cancelPayOSPaymentForUser(USER, reference());
}, ["qr-stage", "fixed-activate", "fixed-cancel"]);

test("a retried transaction sends only what the committed run recorded", async () => {
  reset();
  const ref = { localOrderId: orderId, warehouseId: WAREHOUSE };
  const realRun = db.runTransaction;
  // The first run records a write and aborts; the run that commits writes nothing.
  db.runTransaction = async (work) => {
    await work({}).catch(() => undefined);
    return work({});
  };
  try {
    let runs = 0;
    await runShadowedTransaction("payos-status", async (transaction, recordShadow) => {
      runs += 1;
      if (runs === 1) {
        recordShadow(ref, { orderCode: 1 });
        throw new Error("contention");
      }
    });
  } finally {
    db.runTransaction = realRun;
  }
  assert.equal(steps.length, 0);
});

test("no command is sent when a transaction fails", async () => {
  reset();
  await assert.rejects(runShadowedTransaction("payos-status", async (transaction, recordShadow) => {
    recordShadow({ localOrderId: orderId, warehouseId: WAREHOUSE }, { orderCode: 1 });
    throw new Error("refused");
  }));
  assert.equal(steps.length, 0);
});

// --- The 鲸舰 synchronization after payment, and the invoice request token (round 4) ---

const snapshotOfValue = (value) => ({
  exists: value !== undefined,
  data: () => (value === undefined ? undefined : structuredClone(value)),
});

/**
 * Firestore runs onOrderLocalPaid after every order write; the fake store does
 * not. Run it for what `write` changes, as Firestore would after its last write.
 */
async function written(write) {
  const before = structuredClone(store.get(orderPath()));
  await write();
  await onOrderLocalPaid.run({ data: { before: snapshotOfValue(before), after: snapshotOfValue(order()) }, params: { orderId } });
}

const refused = (code, msg) => () => ({ json: { success: false, code, msg, data: null } });
const unreachable = () => { throw new TypeError("fetch failed"); };
const plainCash = () => {
  // The cash checkout without a voucher writes twice: the payment, then LOCAL_PAID.
  allowTwoWritesPerCommand = true;
  return written(() => cash());
};
const syncedOrder = () => {
  const { status, syncStatus, paymentStatus, hkOrderNumber, version, sync } = order();
  return { status, syncStatus, paymentStatus, hkOrderNumber, version, sync };
};

scenario("cash, then synchronized to 鲸舰", async () => {
  await plainCash();
  assert.deepEqual(hk.calls.map((call) => call.action), ["order_create", "order_pay", "order_pay_query"]);
  // Without a voucher, 鲸舰 settles the full order with its own payment method.
  assert.deepEqual(hk.calls[1].body, { OrderNumber: "O-FAKE-0001", PayAmount: null });
  assert.deepEqual(syncedOrder(), {
    status: "SYNC_SUCCESS",
    syncStatus: "SYNC_SUCCESS",
    paymentStatus: "PAID",
    hkOrderNumber: "O-FAKE-0001",
    version: 3,
    sync: { retryCount: 0, lastError: null, syncedAt: order().updatedAt },
  });
}, ["checkout", "sync-claim", "sync-remote-order", "sync-finish"]);

scenario("a QR paid by webhook, then synchronized", async () => {
  await create();
  tick(MINUTE);
  await written(() => webhook(currentCode()));
  assert.equal(order().status, "SYNC_SUCCESS");
}, ["qr-stage", "payos-reserve", "payos-link", "payos-paid", "sync-claim", "sync-remote-order", "sync-finish"]);

scenario("a cash voucher order is paid at 鲸舰 for its discounted total", async () => {
  await written(() => cash({ items: [{ goodsId: "vé", quantity: 2 }], voucherCodes: ["FREE-0001"] }));
  assert.deepEqual(hk.calls[1].body, { OrderNumber: "O-FAKE-0001", PayAmount: order().totalAmount });
  assert.equal(order().status, "SYNC_SUCCESS");
}, ["checkout", "sync-claim", "sync-remote-order", "sync-finish"]);

scenario("鲸舰 refuses the order, the schedule queues it again and it goes through", async () => {
  hk.script.order_create = [refused(1001, "Goods not found")];
  await plainCash();
  assert.deepEqual(syncedOrder(), {
    status: "SYNC_FAILED",
    syncStatus: "SYNC_FAILED",
    paymentStatus: "PAID",
    hkOrderNumber: null,
    version: 2,
    sync: { retryCount: 1, lastError: "order_create thất bại: [1001] Goods not found", syncedAt: null },
  });
  tick(5 * MINUTE);
  await written(() => retryFailedOrderSyncs.run({}));
  // The schedule keeps the count of failed tries; the success keeps it too.
  assert.deepEqual(order().sync, { retryCount: 1, lastError: null, syncedAt: order().updatedAt });
  assert.equal(order().status, "SYNC_SUCCESS");
}, ["checkout", "sync-claim", "sync-finish", "sync-requeue", "sync-claim", "sync-remote-order", "sync-finish"]);

scenario("鲸舰 cannot be reached when the order is created", async () => {
  hk.script.order_create = [() => ({ status: 502, statusText: "Bad Gateway" })];
  await plainCash();
  assert.equal(order().sync.lastError, "HK API HTTP error: 502 Bad Gateway");
}, ["checkout", "sync-claim", "sync-finish"]);

scenario("鲸舰 answers order_create without an order number", async () => {
  hk.script.order_create = [() => ({ json: { success: true, code: 0, msg: "", data: {} } })];
  await plainCash();
  assert.equal(order().sync.lastError, "order_create không trả về orderNumber.");
}, ["checkout", "sync-claim", "sync-finish"]);

scenario("the payment fails at 鲸舰, a cashier retries it by hand", async () => {
  hk.script.order_pay = [refused(2001, "Pay failed")];
  await plainCash();
  assert.equal(order().hkOrderNumber, "O-FAKE-0001");
  assert.equal(order().sync.lastError, "order_pay thất bại: [2001] Pay failed");
  tick(MINUTE);
  await written(() => retryPosOrderSyncForUser(USER, reference()));
  // The order already exists at 鲸舰: the retry checks its payment first, then pays it.
  assert.deepEqual(hk.calls.slice(3).map((call) => call.action), ["order_pay_query", "order_pay", "order_pay_query"]);
  assert.deepEqual(order().sync, { retryCount: 0, lastError: null, syncedAt: order().updatedAt });
}, ["checkout", "sync-claim", "sync-remote-order", "sync-finish", "sync-retry", "sync-claim", "sync-finish"]);

scenario("the answer to order_pay is lost, the retry finds the order paid", async () => {
  hk.script.order_pay = [(body) => {
    hk.orders.get(body.OrderNumber).paid = true;
    throw new TypeError("fetch failed");
  }];
  await plainCash();
  assert.equal(order().sync.lastError, "fetch failed");
  tick(5 * MINUTE);
  await written(() => retryFailedOrderSyncs.run({}));
  assert.deepEqual(hk.calls.slice(2).map((call) => call.action), ["order_pay_query"]);
  assert.equal(order().status, "SYNC_SUCCESS");
}, ["checkout", "sync-claim", "sync-remote-order", "sync-finish", "sync-requeue", "sync-claim", "sync-finish"]);

scenario("鲸舰 reports the payment although order_pay failed", async () => {
  hk.script.order_pay = [(body) => {
    hk.orders.get(body.OrderNumber).paid = true;
    return { json: { success: false, code: 3001, msg: "Already paid", data: null } };
  }];
  hk.script.order_pay_query = [(body) => ({
    json: { success: true, code: 0, msg: "", data: { orderNumber: body.OrderNumber, payStatus: "2" } },
  })];
  await plainCash();
  assert.equal(order().status, "SYNC_SUCCESS");
}, ["checkout", "sync-claim", "sync-remote-order", "sync-finish"]);

scenario("鲸舰 accepts the payment but does not report it paid", async () => {
  hk.script.order_pay_query = [(body) => ({
    json: { success: true, code: 0, msg: "Processing", data: { orderNumber: body.OrderNumber, payStatus: 1 } },
  })];
  await plainCash();
  assert.equal(order().sync.lastError, "order_pay_query chưa xác nhận đã thanh toán: Processing");
}, ["checkout", "sync-claim", "sync-remote-order", "sync-finish"]);

scenario("鲸舰 cannot be reached when the payment is checked", async () => {
  hk.script.order_pay_query = [unreachable];
  await plainCash();
  assert.equal(order().sync.lastError, "fetch failed");
  assert.equal(order().hkOrderNumber, "O-FAKE-0001");
}, ["checkout", "sync-claim", "sync-remote-order", "sync-finish"]);

scenario("a second delivery of the trigger writes nothing", async () => {
  allowTwoWritesPerCommand = true;
  const before = structuredClone(store.get(orderPath()));
  await cash();
  const paid = order();
  const event = { data: { before: snapshotOfValue(before), after: snapshotOfValue(paid) }, params: { orderId } };
  await onOrderLocalPaid.run(event);
  await onOrderLocalPaid.run(event);
  assert.equal(hk.calls.length, 3);
}, ["checkout", "sync-claim", "sync-remote-order", "sync-finish"]);

scenario("after five failed tries only a cashier can queue the order again", async () => {
  hk.script.order_create = [unreachable];
  await plainCash();
  store.set(orderPath(), { ...order(), sync: { ...order().sync, retryCount: 5 } });
  restartRecording();
  tick(5 * MINUTE);
  await retryFailedOrderSyncs.run({});
  assert.equal(order().status, "SYNC_FAILED");
  await written(() => retryPosOrderSyncForUser(USER, reference()));
  assert.equal(order().status, "SYNC_SUCCESS");
}, ["sync-retry", "sync-claim", "sync-remote-order", "sync-finish"]);

scenario("an old order gets its invoice request token when its receipt is opened", async () => {
  await plainCash();
  const legacy = order();
  delete legacy.invoiceRequestToken;
  delete legacy.invoiceRequestCreatedAt;
  store.set(orderPath(), legacy);
  restartRecording();
  tick(MINUTE);
  await getPosOrderForUser(USER, reference());
  // Opening it again finds the token and writes nothing.
  await getPosOrderForUser(USER, reference());
  assert.match(order().invoiceRequestToken, /^[A-Za-z0-9_-]{43}$/);
}, ["invoice-token"]);
