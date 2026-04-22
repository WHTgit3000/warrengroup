const fs = require("fs");
const path = require("path");

const catalogPath = path.join(__dirname, "..", "data", "catalog.json");

function loadCatalogFile() {
  if (!fs.existsSync(catalogPath)) {
    return {
      generatedAt: null,
      sourceWorkbook: null,
      items: [],
    };
  }

  const raw = fs.readFileSync(catalogPath, "utf8");
  return JSON.parse(raw);
}

function getCatalog() {
  const catalog = loadCatalogFile();
  return catalog.items || [];
}

function getCatalogSummary() {
  const catalog = loadCatalogFile();
  const items = catalog.items || [];

  const byType = items.reduce(
    (acc, item) => {
      if (item.category === "Divorce") acc.divorce += 1;
      if (item.category === "Probate") acc.probate += 1;
      return acc;
    },
    { total: items.length, divorce: 0, probate: 0 }
  );

  return {
    generatedAt: catalog.generatedAt,
    sourceWorkbook: catalog.sourceWorkbook,
    counts: byType,
  };
}

function getRequestOptions() {
  const catalog = loadCatalogFile();
  return catalog.requestOptions || [];
}

module.exports = {
  getCatalog,
  getCatalogSummary,
  getRequestOptions,
};
