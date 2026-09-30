# eBay → Google Sheets inventory sync

A Google Apps Script that lives inside your Google Sheet. Every minute it reads the
current quantities of your eBay listings and mirrors them into the sheet, so
**Available now** drops as items sell and shows **OUT OF STOCK** when a listing hits zero.

## How it works

- **eBay is the source of truth.** The script does not "subtract 1 per sale". It copies
  eBay's own numbers (`Quantity`, `QuantitySold`, available = the difference). A missed run
  or a restart can never double-count a sale, and a restock you make on eBay flows into the sheet.
- Uses the eBay **Trading API** (`GetMyeBaySelling` for active listings, `GetItem` for listings that
  dropped off the active list, e.g. sold out and ended). Unlike the newer Inventory API, this also
  sees listings created in the normal eBay listing form.
- Multi-variation listings are summed across variations.

### Sheet layout (`Inventory` tab)

| Blue: you type | Grey: the sync fills |
|---|---|
| A eBay Item ID · B Product · C SKU / Custom label · D Qty received | E Listed on eBay · F Sold on eBay · G **Available now** · H Status · I Last changed |

- Type either the **Item ID** or the **SKU** (eBay "Custom label"). With only a SKU, the Item ID is filled in for you.
- Active eBay listings that aren't in the sheet are appended automatically (`AUTO_ADD_NEW_LISTINGS` in `Code.gs`).
- `Qty received` is your own record of what came in; it isn't used in the calculation.
- Status: `In stock` / `Low stock` (≤ 2, `LOW_STOCK_THRESHOLD`) / `OUT OF STOCK` / `Listing ended` / `Not found on eBay`.
  Rows in the last three states are not re-checked every minute; clear the Status cell to force a re-check.
- `Sales Log` tab: one line per sync that saw new sales (time, item, units, available after).
- `L1` shows the last successful sync, `L2` the last error, so you can see at a glance if it stopped.

## Setup (about 15 minutes, all in the browser)

1. **eBay developer keys.** Create a free account at developer.ebay.com and an application keyset (Production).
   Copy the **App ID** and **Cert ID**. eBay may ask you to either set up a *Marketplace Account Deletion*
   endpoint or apply for an exemption before enabling Production keys; for a single-seller store the exemption is the easy route.
2. **Put the script in your sheet.** Create a Google Sheet → Extensions → Apps Script. Add `Code.gs` and `Sidebar.html`
   from `apps-script/` (File → + → HTML for the second one, named exactly `Sidebar`). In Project Settings tick
   "Show appsscript.json" and paste in `appsscript.json`.
3. **Deploy as a web app** (this is what lets eBay sign-in finish by itself): Deploy → New deployment → Web app →
   Execute as **Me**, access **Anyone** → Deploy → copy the URL ending in `/exec`.
4. **Create the RuName.** On eBay's developer "User Tokens" page, open *Get a Token from eBay via Your Application*, create a
   RuName, and set **Auth accepted URL** to the web app URL from step 3. Copy the RuName.
5. Reload the sheet and open **eBay Sync → Open eBay Sync panel**. Work down it: *Set up Inventory sheet* →
   paste App ID / Cert ID / RuName → *Save keys* → *Connect eBay account* (sign in on eBay; the panel turns green by itself)
   → *Test connection* → *Sync now* → *Start auto-sync*.

The first run asks Google for permission (external requests, triggers). That's expected. Nobody else can complete an eBay
sign-in against your sheet: each attempt carries a one-time, 10-minute `state` code that the callback checks.

Skipped step 3? The panel also has a "paste the address instead" box that works without a deployed web app.

**If sign-in or *Test connection* fails with a scope/permission error** (I could not check eBay's current scope table
for the Trading API from the build environment): open "Sign-in fails with a scope error?" in the panel and paste an
"Auth'n'Auth" token generated on the same eBay "User Tokens" page. It works with the Trading API without any scopes.

## Limits to know about

- **Near-real-time, not instant.** It polls every minute (the fastest Apps Script allows), so the sheet
  is at most ~1 minute behind. True push would need eBay's notification API and a public HTTPS endpoint
  that eBay can verify, which Apps Script can't serve reliably. Say if you want that, it needs a small hosted service.
- Apps Script quotas (consumer account): 90 min of trigger runtime/day. One sync is ~1–3 s, so 1-minute polling
  fits. If you ever hit it, set `SYNC_EVERY_MINUTES = 5` in `Code.gs`.
- eBay refresh tokens last ~18 months; after that, run *Connect eBay account* again.
- Don't type in the grey columns; the sync overwrites them.

## Tests

`node test/sync.test.js` runs the parsing and sync-planning logic against sample eBay XML (sold-out items,
variations, ended listings, SKU matching, idempotency) and the sign-in callback's state check. It does **not** call eBay.
