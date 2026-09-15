/**
 * The entry point: work out where the data should come from, fetch it, hand
 * it to the dashboard, and then keep it moving.
 *
 * Three ways to open the page:
 *
 *   (nothing)            live, reading the USGS feeds and polling every minute
 *   ?source=snapshot     the saved copy in `data/snapshot`, held still
 *   ?source=snapshot&replay=1
 *                        the saved copy, fed in over time so it moves offline
 */

import { createGrid } from './node_modules/@toclocoinc/lattice-grid/lattice-grid.esm.min.js';
import { createChart } from './node_modules/@toclocoinc/lattice-grid/modules/charts.esm.min.js';
import { createKPI } from './node_modules/@toclocoinc/lattice-grid/modules/kpi.esm.min.js';
import { createTabs } from './node_modules/@toclocoinc/lattice-grid/modules/tabs.esm.min.js';
import { createDataRouter } from './node_modules/@toclocoinc/lattice-grid/modules/data-router.esm.min.js';
import { buildDashboard } from './src/dashboard.js';
import { createReplay, fetchInitial, POLL_MS, shiftToNow, startPolling } from './src/usgs-feed.js';

const TITLE = 'Earthquakes around the world, as they are recorded';

const root = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const mode = params.get('source') === 'snapshot' ? 'snapshot' : 'live';
const replayWanted = params.get('replay') === '1';

/** Draw the waiting state, and return a function that updates its message. */
function showProgress(first) {
  root.textContent = '';
  const panel = document.createElement('div');
  panel.className = 'loading';
  const title = document.createElement('h1');
  title.textContent = TITLE;
  const message = document.createElement('p');
  message.className = 'loading-message';
  message.textContent = first;
  const bar = document.createElement('div');
  bar.className = 'loading-bar';
  const fill = document.createElement('div');
  fill.className = 'loading-fill';
  bar.append(fill);
  panel.append(title, message, bar);
  root.append(panel);
  return (text, fraction) => {
    message.textContent = text;
    fill.style.width = `${Math.round((fraction || 0) * 100)}%`;
  };
}

/** Say what went wrong, in words a reader can act on. */
function showError(error) {
  root.textContent = '';
  const panel = document.createElement('div');
  panel.className = 'loading';
  const title = document.createElement('h1');
  title.textContent = 'The earthquake data could not be loaded';
  const message = document.createElement('p');
  message.className = 'loading-message';
  message.textContent = String((error && error.message) || error);
  const hint = document.createElement('p');
  hint.className = 'loading-message';
  hint.textContent = 'You can open the same dashboard from the saved copy by adding ?source=snapshot to the address.';
  panel.append(title, message, hint);
  root.append(panel);
  console.error('[earthquake demo]', error);
}

/** Read the saved copy that ships with the demo. */
async function loadSnapshot() {
  const [quakes, meta] = await Promise.all(
    ['quakes', 'meta'].map(async (name) => {
      const response = await fetch(`./data/snapshot/${name}.json`);
      if (!response.ok) throw new Error(`The saved copy is missing ${name}.json.`);
      return response.json();
    }),
  );
  return { rows: quakes, meta: { ...meta, live: false } };
}

async function start() {
  const started = performance.now();
  try {
    let rows;
    let meta;
    let significantIds = new Set();

    if (mode === 'snapshot') {
      const update = showProgress('Reading the saved copy...');
      const saved = await loadSnapshot();
      meta = saved.meta;
      rows = saved.rows;
      update('Building the dashboard...', 1);
    } else {
      const update = showProgress('Reading the USGS earthquake feeds...');
      const initial = await fetchInitial({ onProgress: update });
      rows = initial.rows;
      significantIds = initial.significantIds;
      meta = {
        live: true,
        fetchedAt: Date.now(),
        feeds: initial.feeds.map((feed) => ({ name: feed.name, title: feed.title, generated: feed.generated, count: feed.count })),
      };
    }

    const fetched = performance.now();

    /*
     * The saved copy is shifted forward so the newest saved event lands on
     * now. The window is always the last seven days, so without the shift a
     * copy saved a fortnight ago would open with an empty table. The page
     * says plainly that this is what it is doing.
     *
     * `?replay=1` goes further and releases the last stretch a batch at a
     * time, so the saved copy also moves.
     */
    let replay = null;
    let seedRows = rows;
    let shiftMs = 0;
    if (mode === 'snapshot') {
      const shifted = shiftToNow(rows);
      shiftMs = shifted.shiftMs;
      if (replayWanted) {
        replay = { all: shifted.rows };
        seedRows = [];
      } else {
        seedRows = shifted.rows;
      }
      meta.shiftMs = shiftMs;
    }

    const built = buildDashboard({
      root,
      createGrid,
      createChart,
      createKPI,
      createTabs,
      createDataRouter,
      rows: seedRows,
      meta,
    });

    if (replay) {
      const handle = createReplay({
        rows: replay.all,
        onBatch: (batch) => {
          built.ingest(batch);
          built.refreshFigures();
        },
      });
      built.ingest(handle.seed);
      built.refreshFigures();
      built.setFreshness({ replaying: true });
      built.replay = handle;
    }

    let poller = null;
    if (mode === 'live') {
      poller = startPolling({
        significantIds,
        intervalMs: POLL_MS,
        onPoll: (result) => built.onPoll(result),
        onError: (error) => built.onPollError(error),
      });
      built.poller = poller;
    }

    const finished = performance.now();
    const timings = {
      mode: replay ? 'replay' : mode,
      rows: built.allGrid ? built.allGrid.rows.count() : 0,
      loaded: rows.length,
      fetchMs: Math.round(fetched - started),
      buildMs: Math.round(finished - fetched),
      totalMs: Math.round(finished - started),
    };

    /* Kept by reference, not copied: the significant table is only created
       when its tab is first opened, and a copy taken now would never see it. */
    window.__quakeDemo = Object.assign(built, { meta, timings, ready: true });
    console.log('[earthquake demo] ready', timings);
  } catch (error) {
    window.__quakeDemo = { ready: false, error: String((error && error.message) || error) };
    showError(error);
  }
}

start();
