/**
 * Load the demo in a real browser and check that it works.
 *
 * It opens all three ways of reading the page: the saved copy, the live
 * feeds, and the single file preview from disk. Beyond "it drew something",
 * it asserts the four things this demo exists to show:
 *
 *   - narrowing to the notable earthquakes moves the tiles and the charts;
 *   - a revised magnitude lands on the row it belongs to rather than adding
 *     a second one;
 *   - the rolling window drops an event older than seven days while keeping
 *     a fresh one that arrived in the same push;
 *   - every headline figure agrees with the saved feed data, recomputed here
 *     rather than read back off the page.
 *
 * Exits non-zero when any of that fails, so it can gate a deployment.
 *
 * Usage: node tools/verify.mjs [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOTABLE_MAG = 4.5;
/* The grid's retention is a bound, not a guillotine: a row lives up to about
   a tenth of the span past it, plus one tick of the eviction timer. Counts
   near the boundary are checked against that range rather than a point. */
const SLACK_MS = WINDOW_MS * 0.1 + 1000;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

/** The first browser on this machine that actually exists. */
async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`);
}

const failures = [];
const notes = [];

/** Record a check and its outcome. */
function check(ok, description, detail) {
  if (ok) {
    notes.push(`  ok   ${description}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${description}${detail ? ` (${detail})` : ''}`);
    notes.push(`  FAIL ${description}${detail ? ` (${detail})` : ''}`);
  }
}

let browser;
let browserPid = null;
let profile;
let server;

try {
  const chromePath = await findChrome();
  const started = await startServer(0);
  server = started.server;
  const origin = `http://127.0.0.1:${started.port}`;
  console.log(`Browser: ${chromePath}`);
  console.log(`Serving: ${origin}`);

  profile = await mkdtemp(join(tmpdir(), 'quake-demo-verify-'));
  const port = 9333;
  /* Its own process group, so the whole browser tree can be taken down
     together rather than leaving orphaned renderers behind. */
  browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browserPid = browser.pid;
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  let consoleErrors = [];
  let pageErrors = [];

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else ok(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      let value;
      try {
        value = await evaluate(expression);
      } catch {}
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /** Open a URL with a clean error log and wait for the dashboard to report in. */
  const open = async (url, label) => {
    consoleErrors = [];
    pageErrors = [];
    console.log(`\n--- ${label} ---\n${url}`);
    await call('Page.navigate', { url });
    await waitFor('!!(window.__quakeDemo)', 120000, `${label} to load`);
    const state = await evaluate('({ ready: window.__quakeDemo.ready, error: window.__quakeDemo.error || null })');
    if (!state.ready) throw new Error(`${label} reported a failure: ${state.error}`);
    await waitFor('window.__quakeDemo.allGrid && window.__quakeDemo.allGrid.rows.count() > 0', 60000, `${label} rows`);
  };

  /** Save a screenshot, when a directory was asked for. */
  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  shot ${file}`);
  };

  /** Complain about anything the page logged. */
  const noErrors = (label) => {
    check(consoleErrors.length === 0, `${label}: no console errors`, consoleErrors.slice(0, 3).join(' | '));
    check(pageErrors.length === 0, `${label}: no page errors`, pageErrors.slice(0, 3).join(' | '));
  };

  /* =================================================================== */
  /* 1. The saved copy: the deterministic run, where the figures are      */
  /*    cross-checked against the saved feed data.                        */
  /* =================================================================== */

  await open(`${origin}/index.html?source=snapshot`, 'saved copy');

  const snap = await evaluate(`(() => {
    const d = window.__quakeDemo;
    return {
      rows: d.allGrid.rows.count(),
      total: d.allGrid.rows.totalCount(),
      columns: d.allGrid.columns.visible().length,
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      shiftMs: d.meta.shiftMs || 0,
      charts: d.charts.length,
      watermark: d.allGrid.licence.watermark(),
      licenceState: d.allGrid.licence.state(),
      tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
      named: document.querySelector('.kpi-named-value').textContent,
    };
  })()`);
  console.log(`  ${snap.rows} rows, ${snap.columns} columns, ${snap.painted} painted, ${snap.charts} charts`);
  console.log(`  tiles: ${JSON.stringify(snap.tiles)}`);

  check(snap.rows > 0, 'saved copy: the table holds rows', `${snap.rows}`);
  check(snap.painted > 0, 'saved copy: the table painted rows', `${snap.painted}`);
  check(snap.charts === 4, 'saved copy: all four charts were built', `${snap.charts}`);

  /* Built is not drawn. A chart whose points all carry a null measure puts an
     empty pair of axes on the page and reports no error, so each one is asked
     what it actually plotted. */
  const drawn = await evaluate(`(() => window.__quakeDemo.charts.map((c, i) => {
    const data = c.data();
    const series = (data && data.series) || [];
    const points = series.reduce((n, s) => n + ((s.points || []).length), 0);
    const withValue = series.reduce((n, s) => n + (s.points || []).filter((p) => p.y != null && p.y !== 0).length, 0);
    const svg = c.element;
    const marks = svg ? svg.querySelectorAll('rect, circle').length : 0;
    return { i, points, withValue, marks };
  }))()`);
  for (const c of drawn) {
    console.log(`  chart ${c.i}: ${c.points} points, ${c.withValue} with a value, ${c.marks} marks`);
    check(c.withValue > 0, `saved copy: chart ${c.i} plotted values rather than empty axes`, `${c.withValue} of ${c.points} points carry a measure`);
    check(c.marks > 2, `saved copy: chart ${c.i} drew marks`, `${c.marks} marks`);
  }
  check(snap.watermark === false, 'saved copy: no watermark on localhost', `state ${snap.licenceState}`);
  noErrors('saved copy');
  await shoot('01-grid-saved');

  /* The independent recomputation: the saved rows, shifted the same way the
     page shifted them, reduced here in Node. */
  const savedRows = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'quakes.json'), 'utf8'));
  const shifted = savedRows.map((row) => ({ ...row, time: row.time + snap.shiftMs }));
  const now = Date.now();
  const strict = shifted.filter((row) => now - row.time <= WINDOW_MS);
  const slack = shifted.filter((row) => now - row.time <= WINDOW_MS + SLACK_MS);

  const maxMag = (list) => list.reduce((m, r) => (typeof r.mag === 'number' && r.mag > m ? r.mag : m), -Infinity);
  const expectedNotable24 = shifted.filter(
    (row) => typeof row.mag === 'number' && row.mag >= NOTABLE_MAG && row.time >= now - DAY_MS,
  ).length;

  check(
    snap.tiles.events >= strict.length && snap.tiles.events <= slack.length,
    'saved copy: the event count matches the saved feed',
    `tile ${snap.tiles.events}, expected between ${strict.length} and ${slack.length}`,
  );
  check(
    snap.tiles.largest >= maxMag(strict) - 1e-9 && snap.tiles.largest <= maxMag(slack) + 1e-9,
    'saved copy: the largest magnitude matches the saved feed',
    `tile ${snap.tiles.largest}, expected between ${maxMag(strict)} and ${maxMag(slack)}`,
  );
  check(
    snap.tiles.notable24 === expectedNotable24,
    `saved copy: the M${NOTABLE_MAG}+ in 24 hours count matches the saved feed`,
    `tile ${snap.tiles.notable24}, expected ${expectedNotable24}`,
  );

  const newest = shifted.reduce((m, r) => (r.time > m ? r.time : m), 0);
  const expectedSince = Math.round((now - newest) / 60000);
  check(
    Math.abs(snap.tiles.sinceLatest - expectedSince) <= 2,
    'saved copy: minutes since the latest event matches the saved feed',
    `tile ${snap.tiles.sinceLatest}, expected about ${expectedSince}`,
  );
  check(
    /^M\d/.test(snap.named),
    'saved copy: the largest earthquake is named',
    snap.named,
  );

  /* ---- narrowing to the notable earthquakes moves the tiles and charts ---- */

  const before = await evaluate(`(() => {
    const d = window.__quakeDemo;
    return {
      rows: d.allGrid.rows.count(),
      events: d.kpi.value('events'),
      chartRows: d.charts.map((c) => { const data = c.data(); return data ? JSON.stringify(data).length : 0; }),
    };
  })()`);

  await evaluate('window.__quakeDemo.notableButton.click()');
  await sleep(700);

  const after = await evaluate(`(() => {
    const d = window.__quakeDemo;
    return {
      rows: d.allGrid.rows.count(),
      events: d.kpi.value('events'),
      pressed: d.notableButton.getAttribute('aria-pressed'),
      chartRows: d.charts.map((c) => { const data = c.data(); return data ? JSON.stringify(data).length : 0; }),
      minMag: (() => { let m = Infinity; d.allGrid.rows.forEach((r) => { if (r && r.data && typeof r.data.mag === 'number' && r.data.mag < m) m = r.data.mag; }); return m; })(),
    };
  })()`);

  const expectedNotable = strict.filter((row) => typeof row.mag === 'number' && row.mag >= NOTABLE_MAG).length;
  const expectedNotableSlack = slack.filter((row) => typeof row.mag === 'number' && row.mag >= NOTABLE_MAG).length;

  console.log(`  narrowed: ${before.rows} rows -> ${after.rows} rows, tile ${before.events} -> ${after.events}`);
  check(after.pressed === 'true', 'the notable filter reports itself pressed');
  check(after.rows < before.rows, 'the notable filter narrows the table', `${before.rows} -> ${after.rows}`);
  check(after.events < before.events, 'the notable filter moves the event tile', `${before.events} -> ${after.events}`);
  check(
    after.events >= expectedNotable && after.events <= expectedNotableSlack,
    `the narrowed tile matches the saved feed's M${NOTABLE_MAG}+ count`,
    `tile ${after.events}, expected between ${expectedNotable} and ${expectedNotableSlack}`,
  );
  check(after.minMag >= NOTABLE_MAG, 'every remaining row is above the threshold', `smallest ${after.minMag}`);
  const chartsMoved = after.chartRows.filter((size, i) => size !== before.chartRows[i]).length;
  check(chartsMoved > 0, 'the charts rebound to the narrowed data', `${chartsMoved} of ${after.chartRows.length} changed`);
  await shoot('02-charts-filtered');

  await evaluate('window.__quakeDemo.notableButton.click()');
  await sleep(500);
  const restored = await evaluate('window.__quakeDemo.allGrid.rows.count()');
  check(restored === before.rows, 'removing the filter restores the table', `${restored} of ${before.rows}`);

  /* ---- a revision lands on the row it belongs to ---- */

  const revision = await evaluate(`(async () => {
    const d = window.__quakeDemo;
    let target = null;
    d.allGrid.rows.forEach((r) => { if (!target && r && r.data && typeof r.data.mag === 'number') target = r.data; });
    const before = { count: d.allGrid.rows.count(), id: target.id, mag: target.mag };
    d.ingest([{ ...target, mag: Number((target.mag + 1.7).toFixed(1)), updated: target.updated + 1000 }]);
    await new Promise((r) => setTimeout(r, 400));
    let found = null;
    d.allGrid.rows.forEach((r) => { if (r && r.data && r.data.id === before.id) found = r.data; });
    return { before, after: { count: d.allGrid.rows.count(), mag: found ? found.mag : null }, expected: Number((before.mag + 1.7).toFixed(1)) };
  })()`);
  console.log(`  revision: ${revision.before.id} M${revision.before.mag} -> M${revision.after.mag}, rows ${revision.before.count} -> ${revision.after.count}`);
  check(
    revision.after.count === revision.before.count,
    'a revision updates the row rather than adding one',
    `${revision.before.count} -> ${revision.after.count}`,
  );
  check(
    revision.after.mag === revision.expected,
    'the revised magnitude is on the row',
    `expected ${revision.expected}, found ${revision.after.mag}`,
  );

  /* ---- a stale revision is dropped, a newer one is kept ---- */

  const ordering = await evaluate(`(async () => {
    const d = window.__quakeDemo;
    let target = null;
    d.allGrid.rows.forEach((r) => { if (!target && r && r.data && typeof r.data.mag === 'number') target = r.data; });
    const held = { id: target.id, mag: target.mag, updated: target.updated };
    const droppedBefore = d.router.dropped || 0;
    /* An older copy of the same event: its revision stamp is behind the one
       already applied, so it must not undo the correction. */
    d.router.apply([{ op: 'upsert', row: { ...target, mag: 0.1, updated: held.updated - 60000 } }]);
    await new Promise((r) => setTimeout(r, 300));
    let found = null;
    d.allGrid.rows.forEach((r) => { if (r && r.data && r.data.id === held.id) found = r.data; });
    return { held, mag: found ? found.mag : null, dropped: (d.router.dropped || 0) - droppedBefore };
  })()`);
  check(
    ordering.mag === ordering.held.mag,
    'an out of order revision does not undo a correction',
    `magnitude stayed ${ordering.mag}`,
  );
  check(ordering.dropped >= 1, 'the router counted the stale revision it dropped', `${ordering.dropped}`);

  /* ---- the rolling window drops what is too old, and keeps what is not ---- */

  /*
   * Both rows go in inside the window, so both must be admitted. One of them
   * is three seconds from the far edge of it. Waiting for it to cross and
   * rolling the window forward has to take that one out and leave the other,
   * which is the window ageing a row out rather than a push being refused.
   */
  const window7 = await evaluate(`(async () => {
    const d = window.__quakeDemo;
    const now = Date.now();
    const WINDOW = 7 * 24 * 60 * 60 * 1000;
    const base = { updated: now, magType: 'ml', place: 'Window check', depth: 10, lat: 0, lng: 0,
      alert: 'none', tsunami: false, felt: null, cdi: null, mmi: null, sig: 1, net: 'zz',
      status: 'automatic', kind: 'earthquake', url: null, significant: false, count: 1 };
    const present = () => {
      const seen = { fresh: false, expiring: false };
      d.allGrid.rows.forEach((r) => {
        if (!r || !r.data) return;
        if (r.data.id === 'window-check-fresh') seen.fresh = true;
        if (r.data.id === 'window-check-expiring') seen.expiring = true;
      });
      return seen;
    };
    const held = (id) => !!d.allGrid.rows.byKey(id);
    d.ingest([
      { ...base, id: 'window-check-fresh', mag: 3.1, time: now - 60000, day: '' },
      { ...base, id: 'window-check-expiring', mag: 3.2, time: now - WINDOW + 3000, day: '' },
    ]);
    await new Promise((r) => setTimeout(r, 200));
    const admitted = { fresh: held('window-check-fresh'), expiring: held('window-check-expiring') };
    const totalBefore = d.allGrid.rows.totalCount();

    await new Promise((r) => setTimeout(r, 4000));
    const dropped = d.pruneWindow();
    await new Promise((r) => setTimeout(r, 300));
    const settled = { fresh: held('window-check-fresh'), expiring: held('window-check-expiring') };
    const totalAfter = d.allGrid.rows.totalCount();

    /* The walk is read separately. A removed row stays in rows.forEach until
       the next row change arrives, so it is checked after one. */
    const walkedBeforeNextChange = present();
    d.ingest([{ ...base, id: 'window-check-nudge', mag: 1.0, time: Date.now() - 1000, day: '' }]);
    await new Promise((r) => setTimeout(r, 400));
    return { admitted, settled, dropped, totalBefore, totalAfter, walkedBeforeNextChange, walkedAfterNextChange: present() };
  })()`);
  console.log(`  window: admitted ${JSON.stringify(window7.admitted)}, after crossing ${JSON.stringify(window7.settled)}, dropped ${window7.dropped}, total ${window7.totalBefore} -> ${window7.totalAfter}`);
  console.log(`  window: walk before the next change ${JSON.stringify(window7.walkedBeforeNextChange)}, after it ${JSON.stringify(window7.walkedAfterNextChange)}`);
  check(
    window7.admitted.fresh === true && window7.admitted.expiring === true,
    'the window admits both rows while both are inside it',
    JSON.stringify(window7.admitted),
  );
  check(
    window7.settled.expiring === false && window7.dropped >= 1,
    'the rolling window drops an event once it passes seven days',
    `${window7.dropped} dropped, the table no longer holds it`,
  );
  check(
    window7.totalAfter < window7.totalBefore,
    'the dropped event leaves the table',
    `${window7.totalBefore} -> ${window7.totalAfter}`,
  );
  check(
    window7.settled.fresh === true,
    'the rolling window keeps the event that is still inside it',
    'the control row is still in the table',
  );
  check(
    window7.walkedAfterNextChange.expiring === false,
    'the dropped event is gone from the rows the table walks',
    'checked after the next change, because a removal leaves the walk stale until then',
  );

  /* ---- grouping, and the significant tab ---- */

  await evaluate("window.__quakeDemo.allGrid.columns.group(['alert'])");
  await sleep(600);
  const grouped = await evaluate(`(() => {
    const d = window.__quakeDemo;
    let groups = 0;
    d.allGrid.rows.forEach((r) => { if (r && r.group) groups += 1; });
    return { groups, rows: d.allGrid.rows.count() };
  })()`);
  check(grouped.groups > 0, 'grouping by PAGER alert produces group rows', `${grouped.groups} groups`);
  await shoot('03-grouped-by-alert');
  await evaluate('window.__quakeDemo.allGrid.columns.group([])');
  await sleep(400);

  await evaluate("window.__quakeDemo.tabs.activate('significant')");
  await waitFor('window.__quakeDemo.significantGrid && window.__quakeDemo.significantGrid.rows.count() > 0', 30000, 'the significant table');
  const significant = await evaluate(`(() => {
    const d = window.__quakeDemo;
    let allSignificant = true;
    d.significantGrid.rows.forEach((r) => { if (r && r.data && r.data.significant !== true) allSignificant = false; });
    return { rows: d.significantGrid.rows.count(), allSignificant };
  })()`);
  const expectedSignificant = savedRows.filter((row) => row.significant).length;
  console.log(`  significant table: ${significant.rows} rows, saved feed holds ${expectedSignificant}`);
  check(significant.rows > 0, 'the significant table holds rows', `${significant.rows}`);
  check(significant.allSignificant, 'the significant table holds only significant earthquakes');
  check(
    significant.rows === expectedSignificant,
    'the significant table matches the saved significant feed',
    `${significant.rows} against ${expectedSignificant}`,
  );
  await shoot('04-significant-tab');
  noErrors('saved copy, after the checks');

  /* =================================================================== */
  /* 2. Live.                                                            */
  /* =================================================================== */

  await open(`${origin}/index.html`, 'live');
  const live = await evaluate(`(() => {
    const d = window.__quakeDemo;
    return {
      rows: d.allGrid.rows.count(),
      charts: d.charts.length,
      watermark: d.allGrid.licence.watermark(),
      freshness: document.querySelector('.freshness').textContent,
      tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
    };
  })()`);
  console.log(`  ${live.rows} rows from the live feeds; ${live.freshness}`);
  check(live.rows > 0, 'live: the table holds rows from the feed', `${live.rows}`);
  check(live.charts === 4, 'live: all four charts were built', `${live.charts}`);
  check(live.watermark === false, 'live: no watermark on localhost');
  check(typeof live.tiles.events === 'number' && live.tiles.events > 0, 'live: the tiles read the feed', `${live.tiles.events} events`);
  noErrors('live');
  await shoot('05-live');

  /* A poll that fails must leave the table alone and say so. */
  const failed = await evaluate(`(() => {
    const d = window.__quakeDemo;
    const before = d.allGrid.rows.count();
    d.onPollError(new Error('a deliberate failure, for the check'));
    return { before, after: d.allGrid.rows.count(), text: document.querySelector('.freshness').textContent, className: document.querySelector('.freshness').className };
  })()`);
  check(failed.after === failed.before, 'live: a failed poll does not lose the table', `${failed.before} -> ${failed.after}`);
  check(/could not reach/i.test(failed.text), 'live: a failed poll is said out loud', failed.text);
  check(/failed/.test(failed.className), 'live: a failed poll is marked visually', failed.className);

  /* =================================================================== */
  /* 3. The single file preview, opened from disk.                       */
  /* =================================================================== */

  await open(`file://${join(root, 'preview.html')}`, 'preview from disk');
  const preview = await evaluate(`(() => {
    const d = window.__quakeDemo;
    return {
      rows: d.allGrid.rows.count(),
      charts: d.charts.length,
      watermark: d.allGrid.licence.watermark(),
      licenceState: d.allGrid.licence.state(),
      tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
    };
  })()`);
  console.log(`  ${preview.rows} rows, ${preview.charts} charts, licence ${preview.licenceState}`);
  check(preview.rows > 0, 'preview: the table holds rows', `${preview.rows}`);
  check(preview.charts === 4, 'preview: all four charts were built', `${preview.charts}`);
  check(preview.watermark === false, 'preview: no watermark on file://', `state ${preview.licenceState}`);
  noErrors('preview');
  await shoot('06-preview-file');

  socket.close();
} catch (error) {
  failures.push(String((error && error.stack) || error));
} finally {
  /* Take the whole browser tree down, not just the process that was spawned:
     a surviving renderer is an orphan nobody will reap. */
  if (browserPid) {
    try { process.kill(-browserPid, 'SIGKILL'); } catch {}
    try { process.kill(browserPid, 'SIGKILL'); } catch {}
  }
  if (server) server.close();
  await sleep(400);
  if (profile) await rm(profile, { recursive: true, force: true });
}

console.log('\nChecks:');
for (const note of notes) console.log(note);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} checks passed.`);
process.exit(0);
