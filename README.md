# Warren Checkout

Custom checkout starter to replace Jotform while keeping the current Warren Group flow built around Google Sheets, Zapier, Gmail, and Square.

## What this first version does

- Loads county products from the Warren workbook export.
- Lets a customer choose one-time or annual purchase type.
- Prices products on the server so annual pricing is controlled safely.
- Creates a clean order payload for Zapier after checkout.

## Project structure

- `public/` customer-facing checkout page
- `src/` catalog, pricing, and payload helpers
- `scripts/export_catalog.py` workbook-to-JSON exporter
- `data/catalog.json` generated product catalog

## Local workflow

1. Export catalog data from the workbook into `data/catalog.json`
2. Start the local server
3. Open `http://localhost:3000`

## Notes

- Square is stubbed for now so we can wire the app before live credentials are added.
- Zapier payload format is ready to connect later.
