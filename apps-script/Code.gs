/**
 * eBay -> Google Sheets inventory sync.
 *
 * Bound to a Google Sheet (Extensions > Apps Script). Every minute it asks eBay
 * for the current quantity of your listings and mirrors it into the "Inventory"
 * tab. eBay is the source of truth, so a sync can never double-count a sale and
 * a missed run simply catches up on the next one.
 *
 * Setup steps are in ../README.md. Menu: "eBay Sync" (added on open).
 */

// ---------------------------------------------------------------- config ----
const SYNC_EVERY_MINUTES = 1;      // 1, 5, 10, 15 or 30 (Apps Script limits)
const LOW_STOCK_THRESHOLD = 2;     // "Low stock" when available <= this
const AUTO_ADD_NEW_LISTINGS = true; // append active eBay listings missing from the sheet
const MAX_ITEM_LOOKUPS_PER_RUN = 25; // GetItem calls for listings that left the active list

const SHEET_NAME = 'Inventory';
const LOG_SHEET_NAME = 'Sales Log';
const HEADERS = ['eBay Item ID', 'Product', 'SKU / Custom label', 'Qty received',
  'Listed on eBay', 'Sold on eBay', 'Available now', 'Status', 'Last changed'];
const COL = { ITEM_ID: 0, PRODUCT: 1, SKU: 2, RECEIVED: 3, LISTED: 4, SOLD: 5,
  AVAILABLE: 6, STATUS: 7, CHANGED: 8 };
const LOG_HEADERS = ['Time', 'eBay Item ID', 'Product', 'Units sold', 'Available after'];
const STATUS = { IN: 'In stock', LOW: 'Low stock', OUT: 'OUT OF STOCK',
  ENDED: 'Listing ended', MISSING: 'Not found on eBay' };
// Rows in these states are not re-fetched every run (clear the Status cell to force a re-check).
const FINAL_STATUSES = [STATUS.OUT, STATUS.ENDED, STATUS.MISSING];

const OAUTH_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
];
const COMPAT_LEVEL = '1193';

// ------------------------------------------------------------------ menu ----
function onOpen() {
  SpreadsheetApp.getUi().createMenu('eBay Sync')
    .addItem('Open eBay Sync panel', 'showSidebar')
    .addItem('Sync now', 'syncNow')
    .addToUi();
}

function showSidebar() {
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('eBay Sync'));
}

function setupSheet() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME, 0);
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  sheet.getRange('A:A').setNumberFormat('@'); // Item IDs are 12 digits; keep them as text
  sheet.getRange('A1:D1').setBackground('#1d4ed8'); // manual columns
  sheet.getRange('A1').setNote('Manual columns are blue (A-D). Grey columns are filled by the sync - do not type in them.');
  sheet.setColumnWidths(1, HEADERS.length, 120);
  sheet.setColumnWidth(2, 260);

  const status = sheet.getRange('H2:H');
  sheet.setConditionalFormatRules([
    rule_(status, STATUS.OUT, '#fecaca', '#991b1b'),
    rule_(status, STATUS.LOW, '#fef3c7', '#92400e'),
    rule_(status, STATUS.IN, '#dcfce7', '#166534'),
    rule_(status, STATUS.ENDED, '#e5e7eb', '#374151'),
    rule_(status, STATUS.MISSING, '#e5e7eb', '#374151'),
  ]);

  const log = ss.getSheetByName(LOG_SHEET_NAME) || ss.insertSheet(LOG_SHEET_NAME);
  log.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold');
  log.setFrozenRows(1);
  log.getRange('B:B').setNumberFormat('@');

  sheet.getRange('K1:L1').setValues([['Last sync check', '']]).setFontWeight('bold');
  sheet.getRange('K2:L2').setValues([['Last error', '']]).setFontWeight('bold');
}

function rule_(range, text, bg, fg) {
  return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(text)
    .setBackground(bg).setFontColor(fg).setRanges([range]).build();
}

// ------------------------------------------------- panel / credentials ----
// These functions are called from Sidebar.html via google.script.run.
const PROP_KEYS = ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_RUNAME', 'EBAY_REFRESH_TOKEN', 'EBAY_LEGACY_TOKEN'];

/** Status for the panel. Never returns secrets, only whether they are set. */
function getStatus() {
  const p = PropertiesService.getScriptProperties();
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  const syncTriggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncNow');
  return {
    sheetReady: !!sheet,
    hasKeys: !!(p.getProperty('EBAY_CLIENT_ID') && p.getProperty('EBAY_CLIENT_SECRET') && p.getProperty('EBAY_RUNAME')),
    connected: !!(p.getProperty('EBAY_REFRESH_TOKEN') || p.getProperty('EBAY_LEGACY_TOKEN')),
    clientId: p.getProperty('EBAY_CLIENT_ID') || '',
    runame: p.getProperty('EBAY_RUNAME') || '',
    env: p.getProperty('EBAY_ENV') || 'PRODUCTION',
    autoSync: syncTriggers.length > 0,
    everyMinutes: SYNC_EVERY_MINUTES,
    lastSync: sheet ? String(sheet.getRange('L1').getDisplayValue()) : '',
    lastError: sheet ? String(sheet.getRange('L2').getDisplayValue()) : '',
    webAppUrl: ScriptApp.getService().getUrl() || '',
  };
}

/** Saves eBay app keys. An empty secret keeps the one already stored. */
function saveKeys(k) {
  const p = PropertiesService.getScriptProperties();
  const clientId = String(k.clientId || '').trim();
  const runame = String(k.runame || '').trim();
  const secret = String(k.clientSecret || '').trim();
  if (!clientId || !runame || (!secret && !p.getProperty('EBAY_CLIENT_SECRET'))) {
    throw new Error('App ID, Cert ID and RuName are all required.');
  }
  p.setProperty('EBAY_CLIENT_ID', clientId);
  p.setProperty('EBAY_RUNAME', runame);
  if (secret) p.setProperty('EBAY_CLIENT_SECRET', secret);
  p.setProperty('EBAY_ENV', k.env === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION');
  return getStatus();
}

/** Starts the eBay sign-in. The one-time `state` value stops anyone else from completing it. */
function getConnectUrl() {
  const p = PropertiesService.getScriptProperties();
  const clientId = p.getProperty('EBAY_CLIENT_ID');
  const runame = p.getProperty('EBAY_RUNAME');
  if (!clientId || !runame) throw new Error('Save your eBay app keys first.');
  const state = Utilities.getUuid();
  CacheService.getScriptCache().put('oauth_state_' + state, '1', 600);
  return endpoints_().auth + '?client_id=' + encodeURIComponent(clientId) +
    '&response_type=code&redirect_uri=' + encodeURIComponent(runame) +
    '&scope=' + encodeURIComponent(OAUTH_SCOPES.join(' ')) + '&state=' + state;
}

/** Manual fallback: the user pastes the address (or code) they landed on after eBay sign-in. */
function finishConnect(pasted) {
  const code = extractCode_(pasted);
  if (!code) throw new Error('No authorization code found in what you pasted.');
  completeConnect_(code);
  return getStatus();
}

function completeConnect_(code) {
  const p = PropertiesService.getScriptProperties();
  const res = tokenRequest_({ grant_type: 'authorization_code', code: code, redirect_uri: p.getProperty('EBAY_RUNAME') });
  if (!res.refresh_token) throw new Error('eBay did not return a refresh token.');
  p.setProperty('EBAY_REFRESH_TOKEN', res.refresh_token);
  p.deleteProperty('EBAY_LEGACY_TOKEN');
  CacheService.getScriptCache().remove('ebay_access_token');
}

/** eBay redirects here after sign-in when this script is deployed as a web app and its URL is the RuName's accept URL. */
function doGet(e) {
  const params = (e && e.parameter) || {};
  const cache = CacheService.getScriptCache();
  let msg;
  try {
    if (!params.state || !cache.get('oauth_state_' + params.state)) {
      throw new Error('This sign-in was not started from your sheet, or it expired. Start again from the eBay Sync panel.');
    }
    cache.remove('oauth_state_' + params.state);
    if (!params.code) throw new Error(params.error_description || 'eBay did not send a sign-in code.');
    completeConnect_(params.code);
    msg = 'eBay is connected. You can close this tab and go back to your sheet.';
  } catch (err) {
    msg = 'Could not connect eBay: ' + err.message;
  }
  return HtmlService.createHtmlOutput('<div style="font:16px sans-serif;max-width:480px;margin:15vh auto">' +
    escapeXml_(msg) + '</div>').setTitle('eBay Sync');
}

/** Fallback if OAuth scopes are a problem: a legacy Auth'n'Auth token works with the Trading API. */
function saveLegacyToken(token) {
  const t = String(token || '').trim();
  if (!t) throw new Error('Paste the token first.');
  const p = PropertiesService.getScriptProperties();
  p.setProperty('EBAY_LEGACY_TOKEN', t);
  if (!p.getProperty('EBAY_ENV')) p.setProperty('EBAY_ENV', 'PRODUCTION');
  return getStatus();
}

function disconnectEbay() {
  const p = PropertiesService.getScriptProperties();
  PROP_KEYS.forEach(k => p.deleteProperty(k));
  CacheService.getScriptCache().remove('ebay_access_token');
  disableAutoSync();
  return getStatus();
}

function extractCode_(text) {
  const m = String(text).match(/[?&]code=([^&\s]+)/);
  const raw = m ? m[1] : String(text).trim();
  try { return decodeURIComponent(raw); } catch (e) { return raw; }
}

function endpoints_() {
  const sandbox = PropertiesService.getScriptProperties().getProperty('EBAY_ENV') === 'SANDBOX';
  return sandbox
    ? { auth: 'https://auth.sandbox.ebay.com/oauth2/authorize',
        token: 'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
        trading: 'https://api.sandbox.ebay.com/ws/api.dll' }
    : { auth: 'https://auth.ebay.com/oauth2/authorize',
        token: 'https://api.ebay.com/identity/v1/oauth2/token',
        trading: 'https://api.ebay.com/ws/api.dll' };
}

function tokenRequest_(form) {
  const props = PropertiesService.getScriptProperties();
  const basic = Utilities.base64Encode(props.getProperty('EBAY_CLIENT_ID') + ':' + props.getProperty('EBAY_CLIENT_SECRET'));
  const resp = UrlFetchApp.fetch(endpoints_().token, {
    method: 'post',
    headers: { Authorization: 'Basic ' + basic },
    contentType: 'application/x-www-form-urlencoded',
    payload: form,
    muteHttpExceptions: true,
  });
  const body = JSON.parse(resp.getContentText() || '{}');
  if (resp.getResponseCode() >= 300) {
    throw new Error('eBay token error ' + resp.getResponseCode() + ': ' + (body.error_description || body.error || resp.getContentText()));
  }
  return body;
}

function getAccessToken_(forceRefresh) {
  const cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    const cached = cache.get('ebay_access_token');
    if (cached) return cached;
  }
  const refresh = PropertiesService.getScriptProperties().getProperty('EBAY_REFRESH_TOKEN');
  if (!refresh) throw new Error('Not connected to eBay yet. Run "3. Connect eBay account".');
  const res = tokenRequest_({ grant_type: 'refresh_token', refresh_token: refresh });
  cache.put('ebay_access_token', res.access_token, Math.max(60, Math.min(res.expires_in - 300, 21600)));
  return res.access_token;
}

// ------------------------------------------------------------ eBay calls ----
/** Sends one Trading API call and returns the response XML. Retries once on an expired OAuth token. */
function tradingCall_(callName, innerXml, isRetry) {
  const props = PropertiesService.getScriptProperties();
  const legacy = props.getProperty('EBAY_LEGACY_TOKEN');
  const headers = {
    'X-EBAY-API-COMPATIBILITY-LEVEL': COMPAT_LEVEL,
    'X-EBAY-API-CALL-NAME': callName,
    'X-EBAY-API-SITEID': props.getProperty('EBAY_SITE_ID') || '0',
  };
  let creds = '';
  if (legacy) {
    creds = '<RequesterCredentials><eBayAuthToken>' + escapeXml_(legacy) + '</eBayAuthToken></RequesterCredentials>';
  } else {
    headers['X-EBAY-API-IAF-TOKEN'] = getAccessToken_(!!isRetry);
  }
  const xml = '<?xml version="1.0" encoding="utf-8"?><' + callName +
    'Request xmlns="urn:ebay:apis:eBLBaseComponents">' + creds + innerXml + '</' + callName + 'Request>';
  const resp = UrlFetchApp.fetch(endpoints_().trading, {
    method: 'post', headers: headers, contentType: 'text/xml', payload: xml, muteHttpExceptions: true,
  });
  const text = resp.getContentText();
  const err = parseErrors_(text);
  if (resp.getResponseCode() === 401 || /<ErrorCode>(931|932)<\/ErrorCode>/.test(text)) {
    if (!legacy && !isRetry) return tradingCall_(callName, innerXml, true);
  }
  if (resp.getResponseCode() >= 300 || err) {
    throw new Error(callName + ' failed (HTTP ' + resp.getResponseCode() + '): ' + (err || text.slice(0, 300)));
  }
  return text;
}

/** Returns an error message if the response has Ack=Failure (or is unparseable), else ''. */
function parseErrors_(xml) {
  const ack = tagText_(xml, 'Ack');
  if (ack === 'Success' || ack === 'Warning') return '';
  const msgs = [];
  xml.replace(/<Errors>([\s\S]*?)<\/Errors>/g, (_, b) => {
    msgs.push('[' + tagText_(b, 'ErrorCode') + '] ' + (tagText_(b, 'LongMessage') || tagText_(b, 'ShortMessage')));
    return '';
  });
  return msgs.length ? msgs.join(' | ') : (ack ? 'Ack=' + ack : 'Unrecognised response');
}

/** All active listings (paged, 200 per call). Throws if any page fails so we never act on a partial list. */
function fetchActiveListings_() {
  const out = [];
  let page = 1, pages = 1;
  do {
    const xml = tradingCall_('GetMyeBaySelling',
      '<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage>' +
      '<PageNumber>' + page + '</PageNumber></Pagination></ActiveList>');
    parseListings_(xml).forEach(l => out.push(l));
    pages = Number(tagText_(xml, 'TotalNumberOfPages')) || 1;
    page++;
  } while (page <= pages);
  return out;
}

/** One listing by ID (for listings that have dropped off the active list), or null if eBay does not know it. */
function fetchListing_(itemId) {
  try {
    const list = parseListings_(tradingCall_('GetItem', '<ItemID>' + escapeXml_(itemId) + '</ItemID>'));
    return list[0] || null;
  } catch (e) {
    if (/\[(17|21)\]/.test(String(e.message))) return null; // invalid / unknown item ID
    throw e;
  }
}

// --------------------------------------------------------------- parsing ----
function tagText_(xml, tag) {
  const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>').exec(xml);
  return m ? decodeXml_(m[1].trim()) : '';
}

function decodeXml_(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function escapeXml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Turns every <Item> in a GetMyeBaySelling / GetItem response into
 * { itemId, title, sku, quantity, sold, available, listingStatus }.
 * Multi-variation listings are summed across variations.
 */
function parseListings_(xml) {
  const items = [];
  const re = /<Item>([\s\S]*?)<\/Item>/g;
  let m;
  while ((m = re.exec(xml))) {
    let block = m[1].replace(/<Description>[\s\S]*?<\/Description>/g, '');
    let quantity, sold, explicitAvail = null;
    const varBlocks = [];
    block = block.replace(/<Variations>([\s\S]*?)<\/Variations>/, (_, v) => {
      v.replace(/<Variation>([\s\S]*?)<\/Variation>/g, (__, vb) => { varBlocks.push(vb); return ''; });
      return '';
    });
    if (varBlocks.length) {
      quantity = varBlocks.reduce((n, v) => n + (Number(tagText_(v, 'Quantity')) || 0), 0);
      sold = varBlocks.reduce((n, v) => n + (Number(tagText_(v, 'QuantitySold')) || 0), 0);
    } else {
      quantity = Number(tagText_(block, 'Quantity')) || 0;
      sold = Number(tagText_(block, 'QuantitySold')) || 0;
      const qa = tagText_(block, 'QuantityAvailable');
      if (qa !== '') explicitAvail = Number(qa);
    }
    items.push({
      itemId: tagText_(block, 'ItemID'),
      title: tagText_(block, 'Title'),
      sku: tagText_(block, 'SKU'),
      quantity: quantity,
      sold: sold,
      available: explicitAvail !== null ? explicitAvail : Math.max(0, quantity - sold),
      listingStatus: tagText_(block, 'ListingStatus') || 'Active',
    });
  }
  return items.filter(l => l.itemId);
}

// ------------------------------------------------------------------ sync ----
function statusFor_(listing, lowStock) {
  if (listing.available <= 0) return STATUS.OUT;
  if (listing.listingStatus !== 'Active') return STATUS.ENDED;
  return listing.available <= lowStock ? STATUS.LOW : STATUS.IN;
}

/**
 * Pure planning step (no Apps Script services): given the sheet rows and eBay's
 * data, returns the new rows, the sales to log and any brand-new listings.
 *   rows        2D array of sheet values below the header
 *   active      listings from fetchActiveListings_()
 *   lookupItem  function(itemId) -> listing | null, used for rows not in `active`
 *   opts        { now, lowStock, autoAdd, maxLookups }
 */
function planSync_(rows, active, lookupItem, opts) {
  const byId = {}, bySku = {}, seen = {};
  active.forEach(l => { byId[l.itemId] = l; if (l.sku && !bySku[l.sku]) bySku[l.sku] = l; });
  const log = [];
  let lookups = 0;

  const out = rows.map(row => {
    const r = row.slice(0, HEADERS.length);
    while (r.length < HEADERS.length) r.push('');
    const id = String(r[COL.ITEM_ID]).trim();
    const sku = String(r[COL.SKU]).trim();
    if (!id && !sku) return r; // blank / incomplete row: leave alone

    let l = id ? byId[id] : bySku[sku];
    if (!l && id && FINAL_STATUSES.indexOf(r[COL.STATUS]) === -1 && lookups < opts.maxLookups) {
      lookups++;
      l = lookupItem(id);
      if (!l) { setStatus_(r, STATUS.MISSING, opts.now); return r; }
    }
    if (!l) return r; // nothing new to learn about this row

    seen[l.itemId] = true;
    if (!id) r[COL.ITEM_ID] = l.itemId;
    const status = statusFor_(l, opts.lowStock);
    const prevSold = r[COL.SOLD];
    const changed = r[COL.LISTED] !== l.quantity || r[COL.SOLD] !== l.sold ||
      r[COL.AVAILABLE] !== l.available || r[COL.STATUS] !== status;
    if (prevSold !== '' && Number(l.sold) > Number(prevSold)) {
      log.push([opts.now, l.itemId, r[COL.PRODUCT] || l.title, l.sold - Number(prevSold), l.available]);
    }
    r[COL.LISTED] = l.quantity;
    r[COL.SOLD] = l.sold;
    r[COL.AVAILABLE] = l.available;
    r[COL.STATUS] = status;
    if (changed) r[COL.CHANGED] = opts.now;
    return r;
  });

  const added = [];
  if (opts.autoAdd) {
    const known = {};
    out.forEach(r => { known[String(r[COL.ITEM_ID]).trim()] = true; });
    active.forEach(l => {
      if (seen[l.itemId] || known[l.itemId]) return;
      added.push([l.itemId, l.title, l.sku, '', l.quantity, l.sold, l.available,
        statusFor_(l, opts.lowStock), opts.now]);
    });
  }
  return { rows: out, log: log, added: added };
}

function setStatus_(r, status, now) {
  if (r[COL.STATUS] !== status) { r[COL.STATUS] = status; r[COL.CHANGED] = now; }
}

function syncNow() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return; // another run is in progress
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  try {
    if (!sheet) throw new Error('Run "1. Set up sheet" first.');
    const active = fetchActiveListings_();
    const lastRow = sheet.getLastRow();
    const rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues() : [];
    const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');

    const plan = planSync_(rows, active, fetchListing_, {
      now: now, lowStock: LOW_STOCK_THRESHOLD, autoAdd: AUTO_ADD_NEW_LISTINGS, maxLookups: MAX_ITEM_LOOKUPS_PER_RUN,
    });

    if (rows.length) {
      // Only touch columns we own, so a user typing in A-D during the run is never overwritten.
      sheet.getRange(2, COL.LISTED + 1, rows.length, 5)
        .setValues(plan.rows.map(r => r.slice(COL.LISTED, COL.CHANGED + 1)));
      plan.rows.forEach((r, i) => {
        if (String(rows[i][COL.ITEM_ID]).trim() !== String(r[COL.ITEM_ID]).trim()) {
          sheet.getRange(i + 2, 1).setValue(String(r[COL.ITEM_ID])); // matched by SKU: remember the Item ID
        }
      });
    }
    if (plan.added.length) {
      sheet.getRange(lastRow + 1, 1, plan.added.length, HEADERS.length).setValues(plan.added);
    }
    if (plan.log.length) {
      const log = SpreadsheetApp.getActive().getSheetByName(LOG_SHEET_NAME);
      if (log) log.getRange(log.getLastRow() + 1, 1, plan.log.length, LOG_HEADERS.length).setValues(plan.log);
    }
    sheet.getRange('L1').setValue(now);
    sheet.getRange('L2').setValue('');
  } catch (e) {
    console.error(e);
    if (sheet) sheet.getRange('L2').setValue(new Date().toISOString() + ' - ' + e.message);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

// -------------------------------------------------------------- triggers ----
function enableAutoSync() {
  disableAutoSync();
  ScriptApp.newTrigger('syncNow').timeBased().everyMinutes(SYNC_EVERY_MINUTES).create();
  return getStatus();
}

function disableAutoSync() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'syncNow') ScriptApp.deleteTrigger(t);
  });
  return getStatus();
}

/** Returns a message for the panel; throws with eBay's error text on failure. */
function testConnection() {
  return 'Connected to eBay. Found ' + fetchActiveListings_().length + ' active listing(s).';
}
