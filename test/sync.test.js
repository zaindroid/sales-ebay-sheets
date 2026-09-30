// Runs the pure logic in apps-script/Code.gs under Node (no Google services needed).
// Usage: node test/sync.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8') +
  '\nthis.api={parseListings_,parseErrors_,planSync_,extractCode_,STATUS};', ctx);
const { parseListings_, parseErrors_, planSync_, extractCode_, STATUS } = ctx.api;

const activeXml = `<?xml version="1.0"?><GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
<Ack>Success</Ack><ActiveList><ItemArray>
<Item><ItemID>111111111111</ItemID><Title>Juhlani Football &amp; Pump</Title><SKU>JF-01</SKU>
  <Quantity>10</Quantity><QuantityAvailable>7</QuantityAvailable>
  <SellingStatus><QuantitySold>3</QuantitySold></SellingStatus></Item>
<Item><ItemID>222222222222</ItemID><Title>Sold-out (out-of-stock control)</Title>
  <Quantity>5</Quantity><SellingStatus><QuantitySold>5</QuantitySold></SellingStatus></Item>
<Item><ItemID>333333333333</ItemID><Title>Shirt</Title><Variations>
  <Variation><SKU>S</SKU><Quantity>4</Quantity><SellingStatus><QuantitySold>1</QuantitySold></SellingStatus></Variation>
  <Variation><SKU>M</SKU><Quantity>6</Quantity><SellingStatus><QuantitySold>2</QuantitySold></SellingStatus></Variation>
</Variations></Item>
<Item><ItemID>555555555555</ItemID><Title>Brand new listing</Title><Quantity>2</Quantity>
  <SellingStatus><QuantitySold>0</QuantitySold></SellingStatus></Item>
</ItemArray><PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult></ActiveList></GetMyeBaySellingResponse>`;

const J = v => JSON.parse(JSON.stringify(v)); // normalise objects from the vm realm
const active = parseListings_(activeXml);
assert.strictEqual(active.length, 4);
assert.deepStrictEqual(JSON.parse(JSON.stringify(active[0])),
  { itemId: '111111111111', title: 'Juhlani Football & Pump', sku: 'JF-01', quantity: 10, sold: 3, available: 7, listingStatus: 'Active' });
assert.strictEqual(active[1].available, 0);                       // computed from Quantity - QuantitySold
assert.deepStrictEqual([active[2].quantity, active[2].sold, active[2].available], [10, 3, 7]); // variations summed

const getItemXml = `<GetItemResponse><Ack>Success</Ack><Item><ItemID>444444444444</ItemID><Title>Ended one</Title>
<Description><![CDATA[<p>Quantity>99</p>]]></Description><Quantity>8</Quantity>
<SellingStatus><QuantitySold>2</QuantitySold><ListingStatus>Completed</ListingStatus></SellingStatus></Item></GetItemResponse>`;
const ended = parseListings_(getItemXml)[0];
assert.deepStrictEqual([ended.available, ended.listingStatus], [6, 'Completed']);

assert.match(parseErrors_('<Ack>Failure</Ack><Errors><ErrorCode>931</ErrorCode><LongMessage>Auth token is hard expired</LongMessage></Errors>'), /931.*expired/);
assert.strictEqual(parseErrors_('<Ack>Warning</Ack>'), '');
assert.strictEqual(extractCode_('https://x.test/accepted?code=v%5E1.1%23abc&expires_in=299'), 'v^1.1#abc');

// ---- planSync_ ----
const opts = { now: 'T2', lowStock: 2, autoAdd: true, maxLookups: 25 };
const lookedUp = [];
const lookup = id => { lookedUp.push(id); return id === '444444444444' ? ended : null; };
const rows = [
  ['111111111111', 'Juhlani Football', 'JF-01', 10, 10, 0, 10, STATUS.IN, 'T1'],  // 3 sold since last sync
  ['', 'Matched by SKU', 'JF-01', 10, '', '', '', '', ''],                        // no Item ID: matched by SKU
  ['222222222222', 'Sold out', '', 5, 5, 4, 1, STATUS.LOW, 'T1'],                 // last unit sells
  ['444444444444', 'Ended', '', 8, '', '', '', '', ''],                           // off the active list -> GetItem
  ['999999999999', 'Unknown', '', 1, '', '', '', '', ''],                         // eBay has never heard of it
  ['777777777777', 'Already ended', '', 1, 1, 1, 0, STATUS.ENDED, 'T0'],          // final: must not be re-fetched
  ['', '', '', '', '', '', '', '', ''],                                           // blank row
];
const plan = planSync_(rows, active, lookup, opts);
const r = plan.rows.map(J);

assert.deepStrictEqual(r[0].slice(4), [10, 3, 7, STATUS.IN, 'T2']);
assert.strictEqual(r[1][0], '111111111111');                                    // Item ID filled in from SKU
assert.deepStrictEqual(r[2].slice(4), [5, 5, 0, STATUS.OUT, 'T2']);            // hits zero -> OUT OF STOCK
assert.deepStrictEqual(r[3].slice(4), [8, 2, 6, STATUS.ENDED, 'T2']);          // ended with stock left
assert.strictEqual(r[4][7], STATUS.MISSING);
assert.deepStrictEqual(r[5], J(rows[5]));                                       // untouched
assert.deepStrictEqual(r[6], J(rows[6]));
assert.deepStrictEqual(lookedUp, ['444444444444', '999999999999']);            // no lookup for final/active rows

assert.deepStrictEqual(J(plan.log), [
  ['T2', '111111111111', 'Juhlani Football', 3, 7],
  ['T2', '222222222222', 'Sold out', 1, 0],
]);
// listings 333 (variations) and 555 are not in the sheet -> auto-added; 111/222 are not duplicated
assert.deepStrictEqual(J(plan.added).map(x => x[0]), ['333333333333', '555555555555']);

// Idempotent: running again with the same eBay data changes nothing and logs no sales
const again = planSync_(plan.rows, active, lookup, { ...opts, now: 'T3', autoAdd: false });
assert.strictEqual(again.log.length, 0);
assert.strictEqual(J(again.rows[0])[8], 'T2');                                  // "Last changed" not bumped
assert.strictEqual(J(again.rows[2])[8], 'T2');

// Low-stock threshold
assert.strictEqual(J(planSync_([['555555555555', 'x']], active, lookup, opts).rows[0])[7], STATUS.LOW);

console.log('all tests passed');
