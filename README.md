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

## Setup (about 15 minutes)

1. **eBay developer keys.** Create a free account at developer.ebay.com, create an application keyset
   (Production), and copy the **App ID**, **Cert ID** and a **RuName** (User Tokens → "Get a Token from
   eBay via Your Application"; set the accept/decline URLs to any page you own, e.g. `https://example.com/`).
   Note: eBay may ask you to either set up a *Marketplace Account Deletion* endpoint or apply for an
   exemption before enabling Production keys. For a single-seller store the exemption is the easy route.
2. **Sheet.** Create a Google Sheet → Extensions → Apps Script. Replace the editor's code with
   `apps-script/Code.gs`. In Project Settings tick "Show appsscript.json" and paste in `apps-script/appsscript.json`
   (optional, but gives the script the narrowest permissions). Save and reload the sheet.
3. Use the new **eBay Sync** menu, in order:
   1. *Set up sheet*
   2. *Save eBay app keys* (App ID, Cert ID, RuName, PRODUCTION)
   3. *Connect eBay account* (sign in, approve, paste the address you land on)
   4. *Test connection*, which should report your number of active listings
   5. *Sync now*, then *Start auto-sync*

The first run asks Google for permission (external requests, triggers). That's expected.

**If step 3.3/3.4 fails with a scope/permission error** (I could not check eBay's current scope table
for the Trading API from the build environment): use *(or) Use legacy auth token* instead. Generate an
"Auth'n'Auth" token on the same eBay developer "User Tokens" page and paste it. It works with the Trading API
without any scopes. Then run *Test connection* again.

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
variations, ended listings, SKU matching, idempotency). It does **not** call eBay.
