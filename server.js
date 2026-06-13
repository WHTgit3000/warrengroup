const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { getCatalog, getCatalogSummary, getRequestOptions } = require("./src/catalog");
const {
  buildCheckoutOrder,
  buildProductionPayload,
  buildZapierPayload,
  buildLegacyZapPayload,
} = require("./src/pricing");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);
const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${port}`;
const annualWebhookUrl = "https://hooks.zapier.com/hooks/catch/26355247/ujga51r/";
const oneTimeWebhookUrl = "https://hooks.zapier.com/hooks/catch/26355247/ujqmrkz/";
const supportWebhookUrl = "https://hooks.zapier.com/hooks/catch/26355247/4ob9xta/";
const squareEnvironment = process.env.SQUARE_ENVIRONMENT || "sandbox";
const squareAccessToken = process.env.SQUARE_ACCESS_TOKEN || "";
const squareApplicationId = process.env.SQUARE_APPLICATION_ID || "";
const squareLocationId = process.env.SQUARE_LOCATION_ID || "";
const squareApiHost =
  squareEnvironment === "sandbox" ? "connect.squareupsandbox.com" : "connect.squareup.com";
const squareVersion = "2026-01-22";
const pendingOrders = new Map();

function getRequestBaseUrl(req) {
  if (process.env.APP_BASE_URL) {
    return process.env.APP_BASE_URL.replace(/\/+$/, "");
  }

  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const host = req.headers["x-forwarded-host"] || req.headers.host;

  if (host) {
    return `${proto || "http"}://${host}`;
  }

  return appBaseUrl.replace(/\/+$/, "");
}

function sendJson(res, statusCode, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (error, buffer) => {
    if (error) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    res.writeHead(200, { "Content-Type": contentType });
    res.end(buffer);
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", chunk => {
      raw += chunk;
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function postJson(targetUrl, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const body = JSON.stringify(payload);

    const request = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      response => {
        let raw = "";

        response.on("data", chunk => {
          raw += chunk;
        });

        response.on("end", () => {
          resolve({
            statusCode: response.statusCode || 0,
            body: raw,
          });
        });
      }
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function requestJson({ hostname, path: requestPath, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname,
        path: requestPath,
        method,
        headers,
      },
      response => {
        let raw = "";
        response.on("data", chunk => {
          raw += chunk;
        });
        response.on("end", () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (error) {
            parsed = raw;
          }
          resolve({
            statusCode: response.statusCode || 0,
            body: parsed,
          });
        });
      }
    );

    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function getSquareHeaders(body = "") {
  return {
    Authorization: `Bearer ${squareAccessToken}`,
    "Square-Version": squareVersion,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  };
}

async function createSquarePaymentLink(order, baseUrl) {
  if (!squareAccessToken || !squareLocationId || !squareApplicationId) {
    throw new Error("Square credentials are not configured.");
  }

  const body = JSON.stringify({
    idempotency_key: order.submissionId,
    order: {
      location_id: squareLocationId,
      reference_id: order.submissionId,
      line_items: order.lineItems.map(item => ({
        name: item.productName,
        quantity: "1",
        base_price_money: {
          amount: Math.round(item.unitPrice * 100),
          currency: "USD",
        },
      })),
    },
    checkout_options: {
      redirect_url: `${baseUrl}/payment/success?submissionId=${encodeURIComponent(order.submissionId)}`,
      merchant_support_email: "orders@thewarrengroup.com",
      ask_for_shipping_address: false,
      enable_coupon: false,
    },
    pre_populated_data: {
      buyer_email: order.customer.email,
    },
    description: `${order.purchaseType} checkout for ${order.customer.email}`,
    payment_note: `Warren Checkout ${order.submissionId}`,
  });

  const response = await requestJson({
    hostname: squareApiHost,
    path: "/v2/online-checkout/payment-links",
    method: "POST",
    headers: getSquareHeaders(body),
    body,
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Square payment link creation failed: ${
        response.body && response.body.errors ? JSON.stringify(response.body.errors) : response.statusCode
      }`
    );
  }

  return response.body;
}

async function retrieveSquareOrder(orderId) {
  const response = await requestJson({
    hostname: squareApiHost,
    path: `/v2/orders/${encodeURIComponent(orderId)}`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${squareAccessToken}`,
      "Square-Version": squareVersion,
      "Content-Type": "application/json",
    },
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Square order lookup failed: ${
        response.body && response.body.errors ? JSON.stringify(response.body.errors) : response.statusCode
      }`
    );
  }

  return response.body.order;
}

async function searchCompletedSquarePayment(orderId) {
  const body = JSON.stringify({
    query: {
      filter: {
        order_filter: {
          order_ids: [orderId],
        },
      },
      sort: {
        sort_field: "CREATED_AT",
        sort_order: "DESC",
      },
    },
  });

  const response = await requestJson({
    hostname: squareApiHost,
    path: "/v2/payments/search",
    method: "POST",
    headers: getSquareHeaders(body),
    body,
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Square payment lookup failed: ${
        response.body && response.body.errors ? JSON.stringify(response.body.errors) : response.statusCode
      }`
    );
  }

  const payments = Array.isArray(response.body && response.body.payments)
    ? response.body.payments
    : [];

  return payments.find(payment => payment.status === "COMPLETED") || null;
}

async function retrieveSquarePayment(paymentId) {
  const response = await requestJson({
    hostname: squareApiHost,
    path: `/v2/payments/${encodeURIComponent(paymentId)}`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${squareAccessToken}`,
      "Square-Version": squareVersion,
      "Content-Type": "application/json",
    },
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Square payment lookup failed: ${
        response.body && response.body.errors ? JSON.stringify(response.body.errors) : response.statusCode
      }`
    );
  }

  return response.body.payment || null;
}

async function submitOrderToZap(order) {
  const payload = buildLegacyZapPayload(order);
  const webhookUrl =
    order.purchaseType === "Annual Subscription" ? annualWebhookUrl : oneTimeWebhookUrl;
  const webhookResponse = await postJson(webhookUrl, payload);

  return {
    webhookUrl,
    webhookResponse,
  };
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

async function submitSupportRequest(payload) {
  const webhookResponse = await postJson(supportWebhookUrl, payload);
  return {
    webhookUrl: supportWebhookUrl,
    webhookResponse,
  };
}

function buildSupportWebhookPayload(input, submittedAt) {
  const type = String(input.type || "").trim();

  if (type === "missing-county") {
    const customer = input.customer || {};
    const selectedIds = Array.isArray(input.requestedCountyIds) ? input.requestedCountyIds : [];
    const requestOptions = getRequestOptions();
    const selectedLabels = selectedIds
      .map(id => requestOptions.find(item => item.id === id))
      .filter(Boolean)
      .map(item => `${item.category} - ${item.county} County, ${item.state}`);

    return {
      record_type: "missing_county_request",
      submitted_at: submittedAt,
      customer_first_name: String(customer.firstName || "").trim(),
      customer_last_name: String(customer.lastName || "").trim(),
      customer_company_name: String(customer.companyName || "").trim(),
      customer_title: String(customer.title || "").trim(),
      customer_email: String(customer.email || "").trim(),
      customer_telephone: String(customer.telephone || "").trim(),
      request_state: String(input.state || "").trim(),
      requested_county_count: String(selectedIds.length),
      requested_county_ids: selectedIds.join(", "),
      requested_counties: selectedLabels.join("\n"),
      notes: String(input.notes || "").trim(),
    };
  }

  return {
    record_type: "rep_inquiry",
    submitted_at: submittedAt,
    name: String(input.name || "").trim(),
    company: String(input.company || "").trim(),
    email: String(input.email || "").trim(),
    title: String(input.title || "").trim(),
    need: String(input.need || "").trim(),
    notes: String(input.notes || "").trim(),
  };
}

async function handleApi(req, res) {
  if (req.method === "GET" && req.url === "/api/catalog") {
    sendJson(res, 200, {
      summary: getCatalogSummary(),
      items: getCatalog(),
    });
    return true;
  }

  if (req.method === "POST" && req.url === "/api/checkout/quote") {
    try {
      const input = await readRequestBody(req);
      const order = buildCheckoutOrder(input);
      sendJson(res, 200, order);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Invalid request" });
    }
    return true;
  }

  if (req.method === "POST" && req.url === "/api/zapier-preview") {
    try {
      const input = await readRequestBody(req);
      const order = buildCheckoutOrder(input);
      const payload = buildZapierPayload(order);
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Invalid request" });
    }
    return true;
  }

  if (req.method === "POST" && req.url === "/api/checkout/payload-preview") {
    try {
      const input = await readRequestBody(req);
      const order = buildCheckoutOrder(input);
      sendJson(res, 200, {
        order,
        production_payload: buildProductionPayload(order),
        legacy_payload: buildLegacyZapPayload(order),
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Invalid request" });
    }
    return true;
  }

  if (req.method === "GET" && req.url === "/api/request-options") {
    sendJson(res, 200, {
      items: getRequestOptions(),
    });
    return true;
  }

  if (req.method === "POST" && req.url === "/api/support-request") {
    try {
      const input = await readRequestBody(req);
      const type = String(input.type || "").trim();

      if (!type) {
        throw new Error("Request type is required.");
      }
      const submittedAt = new Date().toISOString();
      const webhookPayload = buildSupportWebhookPayload(input, submittedAt);
      const webhookResult = await submitSupportRequest(webhookPayload);

      sendJson(res, 200, {
        success: true,
        submittedAt,
        type,
        message:
          type === "missing-county"
            ? "Missing county request received."
            : "Rep inquiry received.",
        zapierStatusCode: webhookResult.webhookResponse.statusCode,
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Invalid request" });
    }
    return true;
  }

  if (req.method === "POST" && req.url === "/api/checkout/submit") {
    try {
      const input = await readRequestBody(req);
      const order = buildCheckoutOrder(input);
      const webhookResponse = await submitOrderToZap(order);

      sendJson(res, 200, {
        success: true,
        message: `${order.purchaseType} submission sent to Zapier.`,
        zapierStatusCode: webhookResponse.webhookResponse.statusCode,
        submissionId: order.submissionId,
        transactionId: order.transactionId,
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Unable to submit order" });
    }
    return true;
  }

  if (req.method === "POST" && req.url === "/api/checkout/start-payment") {
    try {
      const input = await readRequestBody(req);
      const order = buildCheckoutOrder(input);
      const squareLinkResponse = await createSquarePaymentLink(order, getRequestBaseUrl(req));
      const paymentLink = squareLinkResponse.payment_link;

      pendingOrders.set(order.submissionId, {
        order,
        paymentLinkId: paymentLink.id,
        squareOrderId: paymentLink.order_id,
        submittedToZap: false,
      });

      sendJson(res, 200, {
        success: true,
        checkoutUrl: paymentLink.url || paymentLink.long_url,
        submissionId: order.submissionId,
        transactionId: order.transactionId,
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Unable to start payment" });
    }
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "/";
  const requestUrl = new URL(url, `http://localhost:${port}`);

  if (requestUrl.pathname.startsWith("/api/")) {
    const handled = await handleApi(req, res);
    if (!handled) {
      sendJson(res, 404, { error: "API route not found" });
    }
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (requestUrl.pathname === "/payment/success") {
    const submissionId = requestUrl.searchParams.get("submissionId") || "";
    const transactionId = requestUrl.searchParams.get("transactionId") || "";
    const pending = pendingOrders.get(submissionId);

    if (!pending) {
      sendHtml(
        res,
        404,
        `<html><body style="font-family:Arial,sans-serif;padding:40px;"><h1>Order not found</h1><p>We could not locate that payment session.</p></body></html>`
      );
      return;
    }

    try {
      let squareOrder = null;
      let completedPayment = null;

      try {
        squareOrder = await retrieveSquareOrder(pending.squareOrderId);
        completedPayment = transactionId
          ? await retrieveSquarePayment(transactionId)
          : await searchCompletedSquarePayment(pending.squareOrderId);
      } catch (error) {
        if (squareEnvironment !== "sandbox") {
          throw error;
        }
      }

      if ((!completedPayment || completedPayment.status !== "COMPLETED") && squareEnvironment !== "sandbox") {
        sendHtml(
          res,
          200,
          `<html><body style="font-family:Arial,sans-serif;padding:40px;"><h1>Payment still processing</h1><p>Your payment has not completed yet. Please wait a moment and refresh this page.</p></body></html>`
        );
        return;
      }

      if (!pending.submittedToZap) {
        await submitOrderToZap(pending.order);
        pending.submittedToZap = true;
        pendingOrders.set(submissionId, pending);
      }

      sendHtml(
        res,
        200,
        `<html><body style="font-family:Arial,sans-serif;padding:40px;"><h1>Payment successful</h1><p>Your order has been paid and sent for fulfillment.</p><p>Submission ID: ${submissionId}</p><p>${squareOrder ? `Square order state: ${squareOrder.state}` : "Sandbox payment confirmed through checkout return."}</p><p>You can close this window.</p></body></html>`
      );
    } catch (error) {
      sendHtml(
        res,
        500,
        `<html><body style="font-family:Arial,sans-serif;padding:40px;"><h1>Payment verification issue</h1><p>${String(error.message || error)}</p></body></html>`
      );
    }
    return;
  }

  if (requestUrl.pathname === "/") {
    sendFile(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (requestUrl.pathname === "/app.js") {
    sendFile(res, path.join(publicDir, "app.js"), "application/javascript; charset=utf-8");
    return;
  }

  if (requestUrl.pathname === "/styles.css") {
    sendFile(res, path.join(publicDir, "styles.css"), "text/css; charset=utf-8");
    return;
  }

  if (requestUrl.pathname === "/assets/the-warren-group-stacked-logo-cropped.webp") {
    sendFile(res, path.join(publicDir, "assets", "the-warren-group-stacked-logo-cropped.webp"), "image/webp");
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(port, () => {
  console.log(`Warren Checkout running at http://localhost:${port}`);
});
