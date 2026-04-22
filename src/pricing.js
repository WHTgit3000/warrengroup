const { getCatalog } = require("./catalog");

function createSubmissionId() {
  const timestamp = Date.now().toString();
  const random = Math.floor(100000 + Math.random() * 900000).toString();
  return `${timestamp}${random}`;
}

function getAnnualMultiplier() {
  const parsed = Number(process.env.ANNUAL_MULTIPLIER || 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

function normalizePurchaseType(value) {
  if (value === "annual") return "Annual Subscription";
  return "One-Time Purchase";
}

function toCurrency(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function buildCheckoutOrder(input) {
  const purchaseType = normalizePurchaseType(input.purchaseType);
  const annualMultiplier = getAnnualMultiplier();
  const selectedIds = Array.isArray(input.productIds) ? input.productIds : [];
  const customer = input.customer || {};
  const catalog = getCatalog();
  const submissionId = input.submissionId || createSubmissionId();

  if (!selectedIds.length) {
    throw new Error("Please choose at least one county product.");
  }

  const lineItems = selectedIds.map(id => {
    const product = catalog.find(item => item.id === id);

    if (!product) {
      throw new Error(`Product not found: ${id}`);
    }

    const unitPrice =
      purchaseType === "Annual Subscription"
        ? toCurrency(product.basePrice * annualMultiplier)
        : toCurrency(product.basePrice);

    return {
      id: product.id,
      productName: product.productName,
      category: product.category,
      state: product.state,
      county: product.county,
      link: product.link,
      basePrice: toCurrency(product.basePrice),
      unitPrice,
    };
  });

  const total = toCurrency(lineItems.reduce((sum, item) => sum + item.unitPrice, 0));

  return {
    submissionId,
    formId: "WARREN-CUSTOM-CHECKOUT",
    createdAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    transactionId: input.transactionId || submissionId,
    customer: {
      firstName: String(customer.firstName || "").trim(),
      lastName: String(customer.lastName || "").trim(),
      email: String(customer.email || "").trim(),
    },
    purchaseType,
    annualMultiplier,
    total,
    lineItems,
  };
}

function buildProductsText(order) {
  const productLines = order.lineItems
    .map(item => `${item.productName} (Amount: ${item.unitPrice.toFixed(2)} USD)`)
    .join("\n");

  return [
    productLines,
    `Total: ${order.total.toFixed(2)} USD`,
    `First Name: ${order.customer.firstName}`,
    `Last Name: ${order.customer.lastName}`,
    `Email: ${order.customer.email}`,
    `Transaction ID: ${order.transactionId}`,
  ].join("\n");
}

function buildZapierPayload(order) {
  return {
    first_name: order.customer.firstName,
    last_name: order.customer.lastName,
    email: order.customer.email,
    purchase_type: order.purchaseType,
    total: order.total,
    products: order.lineItems.map(item => ({
      product_name: item.productName,
      price: item.unitPrice,
      link: item.link,
      county: item.county,
      state: item.state,
      category: item.category,
    })),
    product_summary: order.lineItems
      .map(item => `${item.productName} (Amount: ${item.unitPrice.toFixed(2)} USD)`)
      .join("\n"),
  };
}

function buildProductionPayload(order) {
  return {
    submission_id: order.submissionId,
    form_id: order.formId,
    created_at: order.createdAt,
    purchase_type: order.purchaseType,
    first_name: order.customer.firstName,
    last_name: order.customer.lastName,
    email: order.customer.email,
    transaction_id: order.transactionId,
    total: order.total,
    products: order.lineItems.map(item => ({
      product_name: item.productName,
      category: item.category,
      state: item.state,
      county: item.county,
      link: item.link,
      unit_price: item.unitPrice,
    })),
    products_text: buildProductsText(order),
  };
}

function buildLegacyZapPayload(order) {
  const fullName = [order.customer.firstName, order.customer.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    submission_id: order.submissionId,
    form_id: order.formId,
    created_at: order.createdAt,
    first_name: order.customer.firstName,
    last_name: order.customer.lastName,
    email: order.customer.email,
    purchase_type: order.purchaseType,
    transaction_id: order.transactionId,
    total: order.total,
    products: order.lineItems.map(item => item.productName),
    products_text: buildProductsText(order),
    "Submission Id": order.submissionId,
    "Form Id": order.formId,
    "Created At": order.createdAt,
    "Answers Name": fullName,
    "Answers Name First Name": order.customer.firstName,
    "Answers Name Last Name": order.customer.lastName,
    "Answers Email": order.customer.email,
    "Answers My Products": order.lineItems.length,
    "Answers My Products Text": buildProductsText(order),
    "Answers Purchase Type":
      order.purchaseType === "Annual Subscription"
        ? "Annual Subscription (weekly delivery)"
        : "One-Time Purchase",
  };
}

module.exports = {
  buildCheckoutOrder,
  buildProductionPayload,
  buildZapierPayload,
  buildLegacyZapPayload,
};
