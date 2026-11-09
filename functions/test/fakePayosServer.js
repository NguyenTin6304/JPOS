/* eslint-disable @typescript-eslint/no-require-imports */
// Fake PayOS for trying the QR flow on a dev machine. No money moves and nothing
// leaves the machine: it only listens on 127.0.0.1. Signatures use the SDK's own
// code with the fake key in functions/.secret.local.
//
// Run it next to the Functions emulator, with this line in functions/.env.local:
//   PAYOS_BASE_URL=http://127.0.0.1:5055
//
//   node test/fakePayosServer.js
//   open http://127.0.0.1:5055/                                 buttons for the actions below
//   curl -X POST http://127.0.0.1:5055/__pay/latest             customer pays, webhook is sent
//   curl -X POST "http://127.0.0.1:5055/__pay/latest?webhook=0" customer pays, no webhook
//   curl -X POST http://127.0.0.1:5055/__fail-next-create       PayOS refuses the next QR
//   curl http://127.0.0.1:5055/__links                          list of QR codes
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createCryptoProvider } = require("@payos/node/lib/crypto");

const DEFAULT_PORT = 5055;
const DEFAULT_WEBHOOK_URL = "http://127.0.0.1:5001/test-jw-system/asia-southeast1/payosWebhook";

function readChecksumKey() {
  const file = fs.readFileSync(path.join(__dirname, "..", ".secret.local"), "utf8");
  const line = file.split(/\r?\n/).find((text) => text.startsWith("PAYOS_CHECKSUM_KEY="));
  if (!line) throw new Error("functions/.secret.local has no PAYOS_CHECKSUM_KEY");
  return line.slice("PAYOS_CHECKSUM_KEY=".length).trim().replace(/^['"]|['"]$/g, "");
}

function startFakePayOS({ port = DEFAULT_PORT, checksumKey, webhookUrl = DEFAULT_WEBHOOK_URL }) {
  const crypto = createCryptoProvider();
  const links = new Map();
  let latest = null;
  let failNextCreate = false;

  const find = (idOrCode) => [...links.values()].find(
    (link) => link.id === idOrCode || String(link.orderCode) === idOrCode,
  );
  const send = (response, status, body) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const reply = async (response, data) => send(response, 200, {
    code: "00",
    desc: "success",
    data,
    signature: await crypto.createSignatureFromObj(data, checksumKey),
  });
  const information = (link) => ({
    id: link.id,
    orderCode: link.orderCode,
    amount: link.amount,
    amountPaid: link.amountPaid,
    amountRemaining: link.amount - link.amountPaid,
    status: link.status,
    createdAt: link.createdAt,
    transactions: link.transactions,
    canceledAt: link.canceledAt,
    cancellationReason: link.cancellationReason,
  });

  async function createLink(request, response) {
    if (failNextCreate) {
      failNextCreate = false;
      // A business error, not a 5xx: the SDK retries a 5xx and the next try would succeed.
      send(response, 200, { code: "231", desc: "Fake PayOS refused this QR", data: null });
      return;
    }
    const orderCode = request.orderCode;
    const link = {
      id: `fake-link-${orderCode}`,
      orderCode,
      amount: request.amount,
      amountPaid: 0,
      status: "PENDING",
      createdAt: new Date().toISOString(),
      transactions: [],
      canceledAt: null,
      cancellationReason: null,
      description: request.description,
    };
    links.set(orderCode, link);
    latest = link;
    await reply(response, {
      bin: "970422",
      accountNumber: "0000000000",
      accountName: "PAYOS GIA LAP",
      amount: request.amount,
      description: request.description,
      orderCode,
      currency: "VND",
      paymentLinkId: link.id,
      status: "PENDING",
      expiredAt: request.expiredAt ?? null,
      checkoutUrl: `http://127.0.0.1:${port}/${link.id}`,
      qrCode: `FAKE-QR-${orderCode}`,
    });
  }

  async function pay(link, withWebhook, response) {
    const reference = `FAKE${link.orderCode}`;
    const transactionDateTime = new Date().toISOString().slice(0, 19).replace("T", " ");
    link.status = "PAID";
    link.amountPaid = link.amount;
    link.transactions = [{ reference, amount: link.amount, transactionDateTime }];
    let webhookStatus = null;
    if (withWebhook) {
      const data = {
        code: "00",
        desc: "success",
        orderCode: link.orderCode,
        amount: link.amount,
        description: link.description,
        accountNumber: "0000000000",
        reference,
        transactionDateTime,
        currency: "VND",
        paymentLinkId: link.id,
      };
      const result = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "00",
          desc: "success",
          success: true,
          data,
          signature: await crypto.createSignatureFromObj(data, checksumKey),
        }),
      });
      webhookStatus = result.status;
    }
    send(response, 200, { orderCode: link.orderCode, status: link.status, webhookStatus });
  }

  function page() {
    const button = (action, label) =>
      `<form method="post" action="${action}"><button>${label}</button></form>`;
    const rows = [...links.values()].reverse().map((link) => `<tr>
      <td>${link.orderCode}</td><td>${link.amount}</td><td>${link.status}</td>
      <td>${link.status === "PENDING" ? button(`/__pay/${link.orderCode}?page=1`, "Khách đã trả") : ""}</td>
      <td>${link.status === "PENDING" ? button(`/__pay/${link.orderCode}?page=1&webhook=0`, "Khách đã trả, không có webhook") : ""}</td>
    </tr>`).join("");
    return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>PayOS giả</title>
      <meta http-equiv="refresh" content="3">
      <style>body{font:16px sans-serif;margin:24px}td,th{padding:6px 12px;border-bottom:1px solid #ccc;text-align:left}
      form{margin:0}button{font-size:15px;padding:6px 12px}.note{color:#555}</style></head><body>
      <h1>PayOS giả</h1>
      <p class="note">Chỉ chạy trên máy này. Không có tiền thật, không gọi PayOS thật. Trang tự tải lại mỗi 3 giây.</p>
      ${failNextCreate
        ? "<p><b>Mã QR tiếp theo sẽ bị từ chối.</b></p>"
        : button("/__fail-next-create?page=1", "Từ chối mã QR tiếp theo")}
      <h2>Các mã QR, mới nhất trước</h2>
      <table><tr><th>Mã</th><th>Số tiền</th><th>Trạng thái</th><th></th><th></th></tr>${rows}</table>
      </body></html>`;
  }

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://127.0.0.1");
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const parts = url.pathname.split("/").filter(Boolean);
      const backToPage = url.searchParams.get("page") === "1";
      const handle = async () => {
        if (request.method === "GET" && url.pathname === "/") {
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return response.end(page());
        }
        if (request.method === "POST" && url.pathname === "/v2/payment-requests") {
          return createLink(body, response);
        }
        if (parts[0] === "v2" && parts[1] === "payment-requests" && parts[2]) {
          const link = find(parts[2]);
          if (!link) return send(response, 404, { code: "101", desc: "Not found" });
          if (request.method === "POST" && parts[3] === "cancel") {
            if (link.status !== "PAID") {
              link.status = "CANCELLED";
              link.canceledAt = new Date().toISOString();
              link.cancellationReason = body.cancellationReason ?? null;
            }
          }
          return reply(response, information(link));
        }
        if (parts[0] === "__pay") {
          const link = parts[1] === "latest" ? latest : find(parts[1]);
          if (!link) return send(response, 404, { error: "no such QR" });
          if (backToPage) {
            await pay(link, url.searchParams.get("webhook") !== "0", { writeHead() {}, end() {} });
            response.writeHead(303, { Location: "/" });
            return response.end();
          }
          return pay(link, url.searchParams.get("webhook") !== "0", response);
        }
        if (parts[0] === "__fail-next-create") {
          failNextCreate = true;
          if (backToPage) {
            response.writeHead(303, { Location: "/" });
            return response.end();
          }
          return send(response, 200, { failNextCreate });
        }
        if (parts[0] === "__links") {
          return send(response, 200, [...links.values()].map(information));
        }
        return send(response, 404, { error: "unknown path" });
      };
      handle().catch((error) => send(response, 500, { error: error.message }));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

if (require.main === module) {
  startFakePayOS({ checksumKey: readChecksumKey() }).then((server) => {
    console.log(`Fake PayOS on http://127.0.0.1:${server.address().port}`);
  });
}

module.exports = { startFakePayOS };
