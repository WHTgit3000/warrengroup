const state = {
  catalog: [],
  filteredItems: [],
  selectedIds: new Set(),
  activeCategory: "all",
  requestOptions: [],
  filteredRequestOptions: [],
  selectedRequestIds: new Set(),
  activeRequestCategory: "all",
};

async function loadCatalog() {
  const response = await fetch("/api/catalog");
  if (!response.ok) {
    throw new Error("Unable to load catalog.");
  }
  return response.json();
}

async function loadRequestOptions() {
  const response = await fetch("/api/request-options");
  if (!response.ok) {
    throw new Error("Unable to load request options.");
  }
  return response.json();
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function capitalizeWords(value) {
  return String(value || "")
    .split(" ")
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function populateStateFilter(items) {
  const select = document.getElementById("state-filter");
  const states = [...new Set(items.map(item => item.state))].sort();

  states.forEach(code => {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = code;
    select.appendChild(option);
  });
}

function populateRequestStateFilter(items) {
  const select = document.getElementById("request-state-filter");
  const states = [...new Set(items.map(item => item.state))].sort();

  states.forEach(code => {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = code;
    select.appendChild(option);
  });
}

function getFilterValues() {
  return {
    search: document.getElementById("search-input").value.trim().toLowerCase(),
    state: document.getElementById("state-filter").value,
    category: state.activeCategory,
  };
}

function applyFilters() {
  const filters = getFilterValues();

  state.filteredItems = state.catalog.filter(item => {
    const matchesCategory =
      filters.category === "all" || item.category === filters.category;
    const matchesState =
      filters.state === "all" || item.state === filters.state;
    const haystack = `${item.productName} ${item.county} ${item.state}`.toLowerCase();
    const matchesSearch = !filters.search || haystack.includes(filters.search);
    return matchesCategory && matchesState && matchesSearch;
  });

  renderCatalog(state.filteredItems);
  renderCounts();
}

function renderCounts() {
  const resultCount = document.getElementById("result-count");
  const selectedCount = document.getElementById("selected-count");

  resultCount.textContent = `${state.filteredItems.length} results`;
  selectedCount.textContent = `${state.selectedIds.size} selected`;
}

function renderRequestCounts() {
  const resultCount = document.getElementById("request-result-count");
  const selectedCount = document.getElementById("request-selected-count");

  resultCount.textContent = `${state.filteredRequestOptions.length} results`;
  selectedCount.textContent = `${state.selectedRequestIds.size} selected`;
}

function renderEmptySummary(message) {
  const preview = document.getElementById("order-preview");
  preview.innerHTML = `<div class="empty-summary">${escapeHtml(message)}</div>`;
}

function buildGroupedItems(lineItems) {
  const groups = new Map();

  lineItems.forEach(item => {
    const key = `${item.state}|||${item.category}`;
    if (!groups.has(key)) {
      groups.set(key, {
        state: item.state,
        category: item.category,
        items: [],
        total: 0,
      });
    }

    const group = groups.get(key);
    group.items.push(item);
    group.total += item.unitPrice;
  });

  return [...groups.values()].sort((a, b) => {
    if (a.state !== b.state) {
      return a.state.localeCompare(b.state);
    }
    return a.category.localeCompare(b.category);
  });
}

async function refreshSummary() {
  const preview = document.getElementById("order-preview");
  const payload = readFormPayload();

  if (!payload.productIds.length) {
    renderEmptySummary("Select one or more counties to preview the order.");
    return;
  }

  const response = await fetch("/api/checkout/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await response.json();

  if (!response.ok) {
    renderEmptySummary(body.error || "Unable to build the order summary.");
    return;
  }

  const customerName = [body.customer.firstName, body.customer.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  const groupedItems = buildGroupedItems(body.lineItems);
  const groupCards = groupedItems
    .map(
      group => `
        <details class="summary-group">
          <summary class="summary-group-header">
            <div>
              <h3>${escapeHtml(group.state)} - ${escapeHtml(group.category)}</h3>
              <p>${group.items.length} file${group.items.length === 1 ? "" : "s"}</p>
            </div>
            <strong>${formatMoney(group.total)}</strong>
          </summary>
          <div class="summary-group-items">
            ${group.items
              .map(
                item => `
                  <article class="summary-item">
                    <div>
                      <h4>${escapeHtml(item.county)} County</h4>
                      <p>${escapeHtml(item.category)} file</p>
                    </div>
                    <strong>${formatMoney(item.unitPrice)}</strong>
                  </article>
                `
              )
              .join("")}
          </div>
        </details>
      `
    )
    .join("");

  preview.innerHTML = `
    <div class="summary-grid">
      <section class="summary-card">
        <span class="summary-label">Customer</span>
        <strong>${escapeHtml(customerName || "Not entered yet")}</strong>
        <p>${escapeHtml(body.customer.email || "Email not entered yet")}</p>
      </section>
      <section class="summary-card">
        <span class="summary-label">Purchase Type</span>
        <strong>${escapeHtml(body.purchaseType)}</strong>
        <p>${body.lineItems.length} file${body.lineItems.length === 1 ? "" : "s"} selected</p>
      </section>
      <section class="summary-card total-card">
        <span class="summary-label">Total</span>
        <strong>${formatMoney(body.total)}</strong>
        <p>${body.purchaseType === "Annual Subscription" ? "Annual pricing applied" : "One-time pricing applied"}</p>
      </section>
    </div>

    <section class="summary-list">
      <div class="summary-list-header">
        <h3>Selected Files</h3>
        <span>${body.lineItems.length} selected</span>
      </div>
      ${groupCards}
    </section>
  `;
}

function createProductCard(item) {
  const selected = state.selectedIds.has(item.id);
  const article = document.createElement("label");
  article.className = `product-card${selected ? " selected" : ""}`;
  article.innerHTML = `
    <span class="product-check">
      <input type="checkbox" name="productId" value="${escapeHtml(item.id)}" ${selected ? "checked" : ""} />
    </span>
    <span class="product-main">
      <span class="product-title">${escapeHtml(item.county)} County, ${escapeHtml(item.state)}</span>
      <span class="product-meta">
        <span class="tag">${escapeHtml(item.category)}</span>
        <span>${escapeHtml(item.productName)}</span>
      </span>
    </span>
    <span class="product-price">${formatMoney(item.basePrice)}</span>
  `;

  const checkbox = article.querySelector('input[type="checkbox"]');
  checkbox.addEventListener("change", event => {
    if (event.target.checked) {
      state.selectedIds.add(item.id);
    } else {
      state.selectedIds.delete(item.id);
    }

    article.classList.toggle("selected", event.target.checked);
    renderCounts();
    refreshSummary();
  });

  return article;
}

function renderCatalog(items) {
  const catalog = document.getElementById("catalog");
  catalog.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No counties match the current filters.";
    catalog.appendChild(empty);
    return;
  }

  items.forEach(item => {
    catalog.appendChild(createProductCard(item));
  });
}

function updateRequestCategoryButtons() {
  document.querySelectorAll("[data-request-category]").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.requestCategory === state.activeRequestCategory
    );
  });
}

function renderRequestOptions(items) {
  const container = document.getElementById("missing-county-options");
  container.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No unavailable counties match the current filters.";
    container.appendChild(empty);
    return;
  }

  items.forEach(item => {
    const selected = state.selectedRequestIds.has(item.id);
    const row = document.createElement("label");
    row.className = `request-card${selected ? " selected" : ""}`;
    row.innerHTML = `
      <span class="product-check">
        <input type="checkbox" name="requestedCountyId" value="${escapeHtml(item.id)}" ${selected ? "checked" : ""} />
      </span>
      <span class="product-main">
        <span class="product-title">${escapeHtml(item.county)} County, ${escapeHtml(item.state)}</span>
        <span class="product-meta">
          <span class="tag">${escapeHtml(item.category)}</span>
          <span>Not currently available</span>
        </span>
      </span>
    `;

    const checkbox = row.querySelector('input[type="checkbox"]');
    checkbox.addEventListener("change", event => {
      if (event.target.checked) {
        state.selectedRequestIds.add(item.id);
      } else {
        state.selectedRequestIds.delete(item.id);
      }

      row.classList.toggle("selected", event.target.checked);
      renderRequestCounts();
    });

    container.appendChild(row);
  });
}

function applyRequestFilters() {
  const search = document.getElementById("request-search-input").value.trim().toLowerCase();
  const selectedState = document.getElementById("request-state-filter").value;

  state.filteredRequestOptions = state.requestOptions.filter(item => {
    const matchesCategory =
      state.activeRequestCategory === "all" || item.category === state.activeRequestCategory;
    const matchesState =
      selectedState === "all" || item.state === selectedState;
    const haystack = `${item.county} ${item.state} ${item.category}`.toLowerCase();
    const matchesSearch = !search || haystack.includes(search);
    return matchesCategory && matchesState && matchesSearch;
  });

  renderRequestOptions(state.filteredRequestOptions);
  renderRequestCounts();
}

function updateCategoryButtons() {
  document.querySelectorAll(".filter-chip").forEach(button => {
    button.classList.toggle("active", button.dataset.category === state.activeCategory);
  });
}

function readFormPayload() {
  const form = document.getElementById("checkout-form");
  const formData = new FormData(form);

  return {
    purchaseType: formData.get("purchaseType"),
    customer: {
      firstName: formData.get("firstName"),
      lastName: formData.get("lastName"),
      email: formData.get("email"),
    },
    productIds: [...state.selectedIds],
  };
}

async function submitSupportForm(formId, statusId, payloadBuilder) {
  const form = document.getElementById(formId);
  const status = document.getElementById(statusId);

  form.addEventListener("submit", event => {
    event.preventDefault();
    status.textContent = "Saved for follow-up in this preview.";
    status.dataset.state = "success";

    const payload = payloadBuilder(new FormData(form));
    console.log("Support request preview", payload);
    form.reset();
    if (formId === "missing-county-form") {
      state.selectedRequestIds = new Set();
      applyRequestFilters();
    }
  });
}

async function previewOrder(event) {
  event.preventDefault();
  const status = document.getElementById("checkout-status");
  status.textContent = "Opening Square checkout...";
  status.dataset.state = "";

  const response = await fetch("/api/checkout/start-payment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(readFormPayload()),
  });

  const body = await response.json();

  if (!response.ok) {
    status.textContent = body.error || "Unable to submit order.";
    status.dataset.state = "error";
    return;
  }

  status.textContent = "Redirecting to secure payment...";
  status.dataset.state = "success";
  window.location.href = body.checkoutUrl;
}

function attachFilterEvents() {
  document.getElementById("search-input").addEventListener("input", applyFilters);
  document.getElementById("state-filter").addEventListener("change", applyFilters);
  document.querySelectorAll('input[name="purchaseType"]').forEach(input => {
    input.addEventListener("change", refreshSummary);
  });
  document.querySelectorAll('input[name="firstName"], input[name="lastName"], input[name="email"]').forEach(input => {
    input.addEventListener("input", refreshSummary);
  });

  document.querySelectorAll(".filter-chip").forEach(button => {
    button.addEventListener("click", () => {
      if (button.dataset.category) {
        state.activeCategory = button.dataset.category;
        updateCategoryButtons();
        applyFilters();
      }

      if (button.dataset.requestCategory) {
        state.activeRequestCategory = button.dataset.requestCategory;
        updateRequestCategoryButtons();
        applyRequestFilters();
      }
    });
  });

  document.getElementById("request-search-input").addEventListener("input", applyRequestFilters);
  document.getElementById("request-state-filter").addEventListener("change", applyRequestFilters);
}

async function init() {
  const form = document.getElementById("checkout-form");

  try {
    const catalogResponse = await loadCatalog();
    const requestResponse = await loadRequestOptions();
    state.catalog = catalogResponse.items;
    state.requestOptions = requestResponse.items;
    populateStateFilter(state.catalog);
    populateRequestStateFilter(state.requestOptions);

    const counts = catalogResponse.summary.counts;
    document.getElementById("catalog-summary").textContent =
      `${counts.total} products available across ${counts.divorce} divorce files and ${counts.probate} probate files`;

    attachFilterEvents();
    updateCategoryButtons();
    updateRequestCategoryButtons();
    applyFilters();
    applyRequestFilters();
    form.addEventListener("submit", previewOrder);
    submitSupportForm("missing-county-form", "missing-county-status", formData => ({
      type: "missing-county",
      state: formData.get("state"),
      requestedCountyIds: [...state.selectedRequestIds],
      notes: formData.get("notes"),
    }));
    submitSupportForm("rep-inquiry-form", "rep-inquiry-status", formData => ({
      type: "rep-inquiry",
      name: formData.get("name"),
      company: formData.get("company"),
      email: formData.get("email"),
      states: formData.get("states"),
      need: formData.get("need"),
      notes: formData.get("notes"),
    }));
    renderEmptySummary("Select one or more counties to preview the order.");
  } catch (error) {
    renderEmptySummary(error.message);
  }
}

init();
