/* eslint-disable @typescript-eslint/no-require-imports */
// The fake PayOS must satisfy the real SDK, signatures included, so that the QR
// flow can be tried on a dev machine without touching PayOS.
const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { PayOS } = require("@payos/node");
const { startFakePayOS } = require("./fakePayosServer");

const KEY = "fake-checksum-key";
const REQUEST = {
  orderCode: 179430000000001,
  amount: 222,
  description: "LM81 00000-ABC123",
  returnUrl: "https://return.example.test",
  cancelUrl: "https://cancel.example.test",
  expiredAt: 1794300000,
  items: [{ name: "Vé test", quantity: 1, price: 222 }],
};

async function withServers(body) {
  const received = [];
  const webhook = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200).end("{}");
    });
  });
  await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));
  const server = await startFakePayOS({
    port: 0,
    checksumKey: KEY,
    webhookUrl: `http://127.0.0.1:${webhook.address().port}/payosWebhook`,
  });
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const payos = new PayOS({ clientId: "c", apiKey: "a", checksumKey: KEY, baseURL, maxRetries: 0, logLevel: "off" });
  try {
    await body({ payos, baseURL, received });
  } finally {
    server.close();
    webhook.close();
  }
}

test("the SDK accepts the created QR, the status and the cancellation", async () => {
  await withServers(async ({ payos }) => {
    const link = await payos.paymentRequests.create(REQUEST);
    assert.equal(link.status, "PENDING");
    assert.equal(link.expiredAt, REQUEST.expiredAt);
    assert.equal(link.qrCode, `FAKE-QR-${REQUEST.orderCode}`);

    const information = await payos.paymentRequests.get(REQUEST.orderCode);
    assert.equal(information.status, "PENDING");

    const cancelled = await payos.paymentRequests.cancel(link.paymentLinkId, "thử");
    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(cancelled.cancellationReason, "thử");
  });
});

test("paying sends a webhook the SDK verifies, and the status shows it", async () => {
  await withServers(async ({ payos, baseURL, received }) => {
    await payos.paymentRequests.create(REQUEST);

    const paid = await fetch(`${baseURL}/__pay/latest`, { method: "POST" });

    assert.deepEqual(await paid.json(), { orderCode: REQUEST.orderCode, status: "PAID", webhookStatus: 200 });
    const data = await payos.webhooks.verify(received[0]);
    assert.equal(data.code, "00");
    assert.equal(data.amount, REQUEST.amount);
    const information = await payos.paymentRequests.get(REQUEST.orderCode);
    assert.equal(information.amountPaid, REQUEST.amount);
    assert.equal(information.transactions[0].reference, data.reference);
  });
});

test("paying without a webhook only changes the status", async () => {
  await withServers(async ({ payos, baseURL, received }) => {
    await payos.paymentRequests.create(REQUEST);

    await fetch(`${baseURL}/__pay/${REQUEST.orderCode}?webhook=0`, { method: "POST" });

    assert.equal(received.length, 0);
    assert.equal((await payos.paymentRequests.get(REQUEST.orderCode)).status, "PAID");
  });
});

test("the next QR can be refused, even with the retries JPOS configures", async () => {
  await withServers(async ({ baseURL }) => {
    const payos = new PayOS({ clientId: "c", apiKey: "a", checksumKey: KEY, baseURL, maxRetries: 2, logLevel: "off" });
    await fetch(`${baseURL}/__fail-next-create`, { method: "POST" });

    await assert.rejects(payos.paymentRequests.create(REQUEST));
    assert.equal((await payos.paymentRequests.create(REQUEST)).status, "PENDING");
  });
});

test("the page lists the QR codes and its buttons work", async () => {
  await withServers(async ({ payos, baseURL, received }) => {
    await payos.paymentRequests.create(REQUEST);

    const page = await (await fetch(`${baseURL}/`)).text();
    assert.ok(page.includes(String(REQUEST.orderCode)));
    assert.ok(page.includes("Khách đã trả"));

    const clicked = await fetch(`${baseURL}/__pay/${REQUEST.orderCode}?page=1`, { method: "POST", redirect: "manual" });
    assert.equal(clicked.status, 303);
    assert.equal(clicked.headers.get("location"), "/");
    assert.equal(received.length, 1);
    assert.equal((await payos.paymentRequests.get(REQUEST.orderCode)).status, "PAID");
    assert.equal((await (await fetch(`${baseURL}/`)).text()).includes("Khách đã trả"), false);
  });
});

test("an unknown QR is not found", async () => {
  await withServers(async ({ payos }) => {
    await assert.rejects(payos.paymentRequests.get(1));
  });
});
