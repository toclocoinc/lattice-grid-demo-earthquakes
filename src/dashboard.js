/**
 * The dashboard: one arriving stream of earthquakes, and every view built on
 * top of it.
 *
 * The data router is the hub. Nothing here fetches anything and nothing here
 * imports the grid: every factory is handed in, so the same code builds the
 * page you serve locally and the single file preview, which loads the same
 * library a different way.
 *
 * How the pieces fit together:
 *
 *   the feed  ->  the router  ->  the All grid       ->  the tiles
 *                             ->  the Significant grid    the four charts
 *                             ->  a plain subscriber (the activity readout)
 *
 * The All grid keeps a rolling window of the last seven days. The window is
 * the grid's own, declared on its source, so an event ages out of the table
 * whether or not anything new has arrived.
 */

import { ALERT_LABELS, ALERT_LEVELS, NOTABLE_MAG, WINDOW_MS } from './usgs-feed.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Make an element with a class and optional text, the long way round. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** One number, written the way a reader expects to see it. */
function commas(value) {
  return Number(value || 0).toLocaleString('en-GB');
}

/** A magnitude to one decimal place, or a dash when there is none. */
function magText(value) {
  return typeof value === 'number' ? value.toFixed(1) : '-';
}

/** A clock time, local to whoever is reading. */
function clockText(ms) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ------------------------------------------------------------------ */
/* Columns                                                             */
/* ------------------------------------------------------------------ */

/**
 * The earthquake columns, grouped under four headings.
 *
 * `flash: true` on the columns that USGS revises is what makes a correction
 * visible: when a review changes a magnitude or a place, that cell lights up
 * rather than changing silently under the reader.
 *
 * @returns {object[]} the column definitions
 */
function quakeColumns() {
  const coordinate = {
    type: 'number',
    format: { decimals: 3, thousandsSeparator: false },
    filter: { type: 'number' },
    layout: { width: 96 },
  };

  return [
    {
      title: 'When',
      columns: [
        {
          id: 'time',
          field: 'time',
          title: 'Local time',
          type: 'datetime',
          filter: { type: 'date' },
          /*
           * Newest first, which is what a live feed should open on. It also
           * decides the order of the per-day chart: a chart lays its
           * categories out in the order the table walks its rows, so the
           * table's sort is the chart's axis. "Largest first" is a click away.
           */
          sort: { direction: 'desc' },
          layout: { width: 160 },
        },
        {
          id: 'timeUtc',
          title: 'UTC',
          /* The same instant, written in UTC. A reader comparing notes with
             USGS needs this, because every figure USGS publishes is UTC. A
             computed column rather than a second stored field: it is the
             `time` column read a different way. */
          value: {
            deps: ['time'],
            compute: (deps) => {
              const ms = Number(deps.time);
              if (!Number.isFinite(ms)) return null;
              return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
            },
          },
          filter: { type: 'text' },
          layout: { width: 170 },
        },
        {
          id: 'day',
          field: 'day',
          title: 'Day',
          filter: { type: 'set' },
          layout: { width: 110, hidden: true },
        },
      ],
    },
    {
      title: 'The earthquake',
      columns: [
        {
          id: 'mag',
          field: 'mag',
          title: 'Magnitude',
          type: 'number',
          format: { decimals: 1 },
          filter: { type: 'number' },
          flash: true,
          total: 'max',
          groupTotal: 'max',
          layout: { width: 110 },
        },
        {
          id: 'magChange',
          title: 'Revision',
          /* A value the grid keeps about the magnitude column's own history,
             not a field in the feed: how far this event's magnitude has moved
             since it first arrived. */
          shadow: { of: 'mag', kind: 'delta' },
          type: 'number',
          format: { decimals: 1 },
          filter: { type: 'number' },
          layout: { width: 100 },
        },
        {
          id: 'revisions',
          title: 'Revised',
          shadow: { of: 'mag', kind: 'updates' },
          type: 'number',
          filter: { type: 'number' },
          layout: { width: 90, hidden: true },
        },
        {
          id: 'magType',
          field: 'magType',
          title: 'Scale',
          filter: { type: 'set' },
          layout: { width: 90 },
        },
        {
          id: 'place',
          field: 'place',
          title: 'Place',
          filter: { type: 'text' },
          flash: true,
          layout: { width: 300 },
        },
      ],
    },
    {
      title: 'Impact',
      columns: [
        {
          id: 'alert',
          field: 'alert',
          title: 'PAGER alert',
          lookup: { options: Object.entries(ALERT_LABELS).map(([id, label]) => ({ id, label })) },
          filter: { type: 'set' },
          layout: { width: 130 },
        },
        {
          id: 'tsunami',
          field: 'tsunami',
          title: 'Tsunami flag',
          type: 'boolean',
          filter: { type: 'boolean' },
          layout: { width: 120 },
        },
        {
          id: 'felt',
          field: 'felt',
          title: 'Felt reports',
          type: 'number',
          filter: { type: 'number' },
          total: 'sum',
          groupTotal: 'sum',
          layout: { width: 110 },
        },
        {
          id: 'sig',
          field: 'sig',
          title: 'Significance',
          type: 'number',
          filter: { type: 'number' },
          layout: { width: 110, hidden: true },
        },
      ],
    },
    {
      title: 'Where and who',
      columns: [
        {
          id: 'depth',
          field: 'depth',
          title: 'Depth (km)',
          type: 'number',
          format: { decimals: 1 },
          filter: { type: 'number' },
          layout: { width: 110 },
        },
        { ...coordinate, id: 'lat', field: 'lat', title: 'Latitude' },
        { ...coordinate, id: 'lng', field: 'lng', title: 'Longitude' },
        {
          id: 'net',
          field: 'net',
          title: 'Network',
          filter: { type: 'set' },
          layout: { width: 100 },
        },
        {
          id: 'status',
          field: 'status',
          title: 'Status',
          filter: { type: 'set' },
          flash: true,
          layout: { width: 110 },
        },
        {
          id: 'url',
          field: 'url',
          title: 'USGS page',
          cell: { render: 'link', props: { text: 'Open', target: '_blank', rel: 'noopener' } },
          filter: { type: 'none' },
          sort: false,
          layout: { width: 110 },
        },
        /* Always 1. It is what the charts add up and what a group subtotal
           counts, so it is available but starts out of the way. */
        {
          id: 'count',
          field: 'count',
          title: 'Events',
          type: 'number',
          total: 'sum',
          groupTotal: 'sum',
          filter: { type: 'none' },
          layout: { width: 90, hidden: true },
        },
      ],
    },
  ];
}

/**
 * The traffic lights on the PAGER alert column, and a scale on magnitude.
 *
 * These are conditional formatting rules the grid holds as runtime state, so
 * a reader can open the Formatting panel and change them.
 *
 * @returns {object} rules keyed by column id
 */
function formattingRules() {
  const alertColours = {
    green: { background: '#1b5e20', color: '#ffffff' },
    yellow: { background: '#f9a825', color: '#1b1b1b' },
    orange: { background: '#e65100', color: '#ffffff' },
    red: { background: '#b3261e', color: '#ffffff' },
  };
  return {
    alert: ALERT_LEVELS.map((level) => ({
      id: `alert-${level}`,
      label: `PAGER ${ALERT_LABELS[level]}`,
      when: { op: 'eq', value: level },
      style: { ...alertColours[level], fontWeight: '600', textAlign: 'center' },
    })),
    mag: [
      {
        id: 'mag-notable',
        label: `Magnitude ${NOTABLE_MAG} and above`,
        when: { op: 'gte', value: NOTABLE_MAG },
        style: { fontWeight: '700', color: '#b3261e' },
      },
    ],
    magChange: [
      {
        id: 'mag-revised-up',
        label: 'Revised upwards',
        when: { op: 'gt', value: 0 },
        style: { color: '#b3261e', fontWeight: '600' },
      },
      {
        id: 'mag-revised-down',
        label: 'Revised downwards',
        when: { op: 'lt', value: 0 },
        style: { color: '#1b5e20', fontWeight: '600' },
      },
    ],
  };
}

/**
 * The shared grid settings both tables use.
 *
 * @param {string} title the table's heading
 * @returns {object} a partial grid config
 */
function baseGridConfig(title) {
  return {
    rowKey: 'id',
    columns: quakeColumns(),
    formatting: formattingRules(),
    theme: 'light',
    density: 'compact',
    stripedRows: true,
    columnMenu: true,
    groupPanel: true,
    statusBar: true,
    find: true,
    grandTotalRow: 'bottom',
    groupDefaultExpanded: 0,
    toolPanel: { side: 'right', panels: ['filters', 'columns', 'formatting'] },
    selection: 'multiple',
    /* A corrected magnitude or place lights up for a moment rather than
       changing silently. This is the whole point of the live view. */
    highlightOnChange: { colour: '#ffe8a3', duration: 2500 },
    title,
  };
}

/* ------------------------------------------------------------------ */
/* Reading what the grid currently matches                             */
/* ------------------------------------------------------------------ */

/**
 * Every earthquake the grid currently matches, whether or not it is grouped.
 *
 * Walking the grid gives back what is on screen, and once the rows are
 * grouped that is a handful of headings rather than the earthquakes
 * themselves. Taking the leaves beneath each heading, keyed so an open group
 * is not counted twice, gives the same set in either arrangement.
 *
 * @param {object} grid the grid to read
 * @returns {object[]} the matched data rows
 */
function matchedRows(grid) {
  if (!grid) return [];
  const seen = new Map();
  grid.rows.forEach((row) => {
    if (!row) return;
    if (row.group) {
      for (const leaf of grid.rows.leavesOf(row.key) || []) {
        if (leaf && leaf.data) seen.set(leaf.key, leaf.data);
      }
    } else if (row.data) {
      seen.set(row.key, row.data);
    }
  });
  return [...seen.values()];
}

/* ------------------------------------------------------------------ */
/* The dashboard                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build the whole page into `root`.
 *
 * @param {object} options
 * @param {HTMLElement} options.root where the dashboard is drawn
 * @param {Function} options.createGrid the grid factory
 * @param {Function} options.createChart the charts module's factory
 * @param {Function} options.createKPI the KPI module's factory
 * @param {Function} options.createTabs the tabs module's factory
 * @param {Function} options.createDataRouter the data router module's factory
 * @param {object[]} options.rows the earthquakes to start with
 * @param {object} options.meta where the data came from, and when
 * @returns {object} the pieces that were built, for a caller that wants them
 */
export function buildDashboard({
  root,
  createGrid,
  createChart,
  createKPI,
  createTabs,
  createDataRouter,
  rows,
  meta,
}) {
  root.textContent = '';

  const built = {
    allGrid: null,
    significantGrid: null,
    router: null,
    kpi: null,
    charts: [],
    tabs: null,
    /* Everything the page currently holds, by id. The router drives the
       views; this is what a re-load or a snapshot is built from. */
    store: new Map(),
    status: { lastPoll: null, lastError: null, polls: 0, revisions: 0, arrivals: 0, dropped: 0 },
  };

  /* ---------------- the masthead ---------------- */

  const header = el('header', 'head');
  const heading = el('div', 'head-text');
  heading.append(el('h1', null, 'Earthquakes around the world, as they are recorded'));
  heading.append(
    el(
      'p',
      'lede',
      'Every earthquake the United States Geological Survey has recorded in the last seven days, ' +
        'updated each minute. Magnitudes and locations are revised for hours after an event, ' +
        'and a revision lands on the row it belongs to rather than adding a second one.',
    ),
  );
  /*
   * When the live feeds could not be reached the saved copy is shown instead,
   * and this says so. A reader should never have to wonder whether the
   * figures in front of them are today's.
   */
  if (meta.fellBack) {
    heading.append(
      el(
        'p',
        'notice',
        'The USGS earthquake feeds could not be reached, so this is the saved copy. Reloading the page will try again.',
      ),
    );
  }
  header.append(heading);

  const provenance = el('div', 'head-note');
  const modePill = el('span', 'pill', meta.live ? 'Live' : 'Saved copy');
  const liveDot = el('span', 'dot');
  if (meta.live) modePill.prepend(liveDot);
  const freshness = el('span', 'freshness', 'Waiting for the first update...');
  provenance.append(modePill, freshness);
  header.append(provenance);
  root.append(header);

  /* ---------------- the tiles ---------------- */

  const kpiHost = el('section', 'kpi-strip');
  kpiHost.setAttribute('aria-label', 'Headline figures');
  const panelHost = el('div', 'kpi-panel');
  const namedTile = el('div', 'kpi-named');
  const namedValue = el('div', 'kpi-named-value', 'No data');
  const namedLabel = el('div', 'kpi-named-label', 'Largest earthquake in view');
  namedTile.append(namedValue, namedLabel);
  kpiHost.append(panelHost, namedTile);
  root.append(kpiHost);

  /* ---------------- the charts ---------------- */

  const chartHost = el('section', 'chart-wrap');
  chartHost.setAttribute('aria-label', 'Charts');
  const chartBoxes = [];
  for (let i = 0; i < 4; i += 1) {
    const box = el('div', 'chart-box');
    chartHost.append(box);
    chartBoxes.push(box);
  }
  root.append(chartHost);

  /* ---------------- the controls ---------------- */

  const actions = el('div', 'actions');
  root.append(actions);

  /* ---------------- the tables ---------------- */

  const tabsHost = el('section', 'tabs-host');
  root.append(tabsHost);

  /*
   * A note on how the seven day window is kept.
   *
   * The grid has a rolling time window of its own: `maxAge` and `ageBy` on a
   * stream source, which is exactly this shape of problem. It is not used
   * here, because a stream source that is still open makes the table stop
   * filtering and stop grouping, silently and with no warning: a filter set
   * on one matches every row, and asking for groups produces none. Both come
   * back the moment the stream is declared finished, which a live feed never
   * is. A table nobody can filter is not worth a window, so the window is
   * kept here instead, by deleting through the router.
   */
  const tabs = createTabs(tabsHost, {
    createGrid,
    ariaLabel: 'Earthquake views',
    tabs: [
      {
        id: 'all',
        label: 'All earthquakes',
        badge: true,
        config: {
          ...baseGridConfig('Earthquakes in the last seven days'),
          rows: [],
        },
      },
      {
        id: 'significant',
        label: 'Significant',
        badge: true,
        config: {
          /*
           * A second dataset, not a filter over the first. The significant
           * feed reaches back a month, so it holds events the seven day
           * window has already dropped; narrowing the All table could never
           * show them. It therefore has no rolling window of its own.
           */
          ...baseGridConfig('Significant earthquakes in the last month'),
          rows: [],
        },
      },
    ],
  });
  built.tabs = tabs;
  built.allGrid = tabs.tab('all');

  /* ---------------- the router ---------------- */

  /*
   * One stream in, several viewers out.
   *
   * `overlap: true` is what lets a significant earthquake reach both tables:
   * without it a record stops at the first route it matches and the second
   * table would silently receive nothing.
   *
   * `seq: 'updated'` is the feed's own revision clock. USGS stamps every
   * revision with the moment it was made, so an older copy of a row arriving
   * after a newer one is dropped rather than undoing the correction.
   */
  const router = createDataRouter({
    key: (row) => (row.significant ? 'significant' : 'all'),
    rowKey: 'id',
    overlap: true,
    seq: 'updated',
  });
  built.router = router;

  /* Ids taken out of the All table by age while still being held for the
     significant table. */
  const outOfWindow = new Set();

  /*
   * The All route admits what is inside the window, so a month old
   * significant earthquake never enters it in the first place. Ageing out
   * afterwards is the job of `pruneWindow`.
   */
  router.attach(built.allGrid, (row) => Date.now() - row.time <= WINDOW_MS);

  /* A route that renders nothing: it counts what arrives, for the readout
     under the masthead. The router hands it the same keyed diff a table
     gets. */
  router.subscribe(() => true, (change) => {
    built.status.arrivals += (change.add || []).length;
    built.status.revisions += (change.update || []).length;
  });

  /**
   * Put rows into the store and through the router.
   *
   * @param {object[]} incoming the rows to apply
   * @returns {number} how many rows were applied
   */
  const ingest = (incoming) => {
    if (!incoming || !incoming.length) return 0;
    for (const row of incoming) built.store.set(row.id, row);
    router.apply(incoming.map((row) => ({ op: 'upsert', row })));
    built.status.dropped = router.dropped || 0;
    return incoming.length;
  };

  /**
   * Roll the window forward: take out everything that has aged past it.
   *
   * An ordinary earthquake leaves after seven days. A significant one is kept
   * for a month, because the significant table reads a month long feed and
   * still shows it; it leaves the All table anyway, because that table only
   * ever shows the routed rows younger than the window.
   *
   * This runs on a timer as well as after each poll, so the window keeps
   * shrinking through a quiet spell rather than freezing on the last thing
   * that happened to arrive.
   *
   * @returns {number} how many earthquakes were dropped
   */
  const pruneWindow = () => {
    const now = Date.now();
    const goneFromAll = [];
    const goneEntirely = [];
    for (const [id, row] of built.store) {
      const age = now - row.time;
      if (age <= WINDOW_MS) continue;
      if (row.significant && age <= 30 * DAY_MS) {
        /* Still wanted by the significant table, so it only leaves the
           window. Remembered, so a later pass does not keep asking the table
           to remove a row that has already gone. */
        if (!outOfWindow.has(id)) {
          goneFromAll.push(id);
          outOfWindow.add(id);
        }
      } else {
        goneEntirely.push(id);
        built.store.delete(id);
        outOfWindow.delete(id);
      }
    }
    if (goneEntirely.length) {
      router.apply(goneEntirely.map((id) => ({ op: 'delete', row: { id } })));
    }
    if (goneFromAll.length && built.allGrid) {
      built.allGrid.rows.apply({ remove: goneFromAll });
    }
    return goneEntirely.length + goneFromAll.length;
  };
  built.pruneWindow = pruneWindow;

  /* The significant table is built the first time its tab is opened, so it is
     attached to the router at that moment and filled from the store. */
  const attachSignificant = () => {
    if (built.significantGrid) return;
    const grid = tabs.tab('significant');
    if (!grid) return;
    built.significantGrid = grid;
    router.attach(grid, (row) => row.significant === true);
    /* A snapshot is a keyed diff, so this fills the new table without
       repainting the one that was already there. */
    outOfWindow.clear();
    router.load([...built.store.values()]);
    pruneWindow();
  };
  tabs.on('tab:changed', (event) => {
    if (event.id === 'significant') attachSignificant();
  });

  /* The first load. A snapshot is a keyed diff, so calling this again later
     updates what changed rather than repainting everything. */
  for (const row of rows) built.store.set(row.id, row);
  router.load([...built.store.values()]);

  /* ---------------- the tiles, bound to the All table ---------------- */

  const kpi = createKPI(panelHost, {
    /*
     * Fed the earthquakes the table currently matches, rather than bound to
     * the table.
     *
     * A bound panel is handed a projection of each row rather than the row
     * itself, and a timestamp column arrives in it already written out as
     * text. Anything doing arithmetic on a time then compares a string with a
     * number, which is not an error in JavaScript, just quietly false. These
     * tiles measure elapsed time, so they are given the real rows.
     */
    rows: [],
    rowKey: 'id',
    columns: 5,
    ariaLabel: 'Headline figures',
    tiles: [
      { id: 'events', label: 'Earthquakes in the window', aggregation: 'count', format: 'number' },
      {
        id: 'largest',
        label: 'Largest magnitude',
        aggregation: 'max',
        field: 'mag',
        format: { type: 'number', decimals: 1 },
      },
      {
        id: 'notable24',
        label: `M${NOTABLE_MAG}+ in the last 24 hours`,
        aggregation: 'custom',
        format: 'number',
        compute: (tileRows) => {
          const since = Date.now() - DAY_MS;
          let n = 0;
          for (const row of tileRows) {
            if (typeof row.mag === 'number' && row.mag >= NOTABLE_MAG && row.time >= since) n += 1;
          }
          return n;
        },
      },
      {
        id: 'sinceLatest',
        label: 'Minutes since the latest',
        aggregation: 'custom',
        format: { type: 'number', decimals: 0 },
        /* Quiet is normal; a long silence usually means the feed, not the
           planet, has gone quiet. */
        thresholds: { warn: 60, critical: 240, direction: 'lowerIsBetter' },
        compute: (tileRows) => {
          let newest = 0;
          for (const row of tileRows) if (row.time > newest) newest = row.time;
          if (!newest) return null;
          return Math.max(0, Math.round((Date.now() - newest) / 60000));
        },
      },
      {
        id: 'sincePoll',
        label: 'Minutes since the last update',
        aggregation: 'custom',
        format: { type: 'number', decimals: 0 },
        thresholds: { warn: 2, critical: 5, direction: 'lowerIsBetter' },
        compute: () => {
          const at = built.status.lastPoll;
          if (!at) return null;
          return Math.max(0, Math.round((Date.now() - at) / 60000));
        },
      },
    ],
  });
  built.kpi = kpi;

  /** Name the largest earthquake in view, which is a phrase rather than a figure. */
  const refreshNamedTile = (inView) => {
    let biggest = null;
    for (const row of inView) {
      if (typeof row.mag !== 'number') continue;
      if (!biggest || row.mag > biggest.mag) biggest = row;
    }
    if (!biggest) {
      namedValue.textContent = 'No data';
      namedLabel.textContent = 'Largest earthquake in view';
      return;
    }
    namedValue.textContent = `M${magText(biggest.mag)} ${biggest.place}`;
    namedLabel.textContent = `Largest in view, ${new Date(biggest.time).toLocaleString('en-GB')}`;
  };

  /**
   * Recompute every figure from what the table currently matches.
   *
   * The panel does not follow the table's filters by itself, so the host
   * hands it the matched rows: without this the tiles would keep reporting
   * the whole window while the table showed a narrowed set.
   */
  const refreshFigures = () => {
    const inView = matchedRows(built.allGrid);
    kpi.setRows(inView);
    refreshNamedTile(inView);
  };
  built.refreshFigures = refreshFigures;

  built.allGrid.on('filter:changed', refreshFigures);
  built.allGrid.on('model:changed', refreshFigures);
  built.allGrid.on('column:grouped', refreshFigures);

  /* Two of the tiles are about elapsed time, so they move on their own. */
  const clock = setInterval(refreshFigures, 15000);

  /*
   * The window rolls forward whether or not anything arrives. Without this
   * the oldest day would sit in the table until the next earthquake happened
   * to be reported, which on a quiet feed can be a long time.
   */
  const windowClock = setInterval(() => {
    if (pruneWindow() > 0) refreshFigures();
  }, 30000);

  /* ---------------- the charts ---------------- */

  const chartSpecs = [
    {
      type: 'histogram',
      x: 'mag',
      /* The measure is named even though a histogram counts: without a `y`
         every bar comes back with no height and the chart draws nothing. */
      y: 'count',
      buckets: 14,
      title: 'How many earthquakes at each magnitude',
      /*
       * The bars and their order are right, lowest magnitude on the left.
       * The numbers along the bottom are band numbers rather than
       * magnitudes, so the axis is titled to say so: asking for the labels
       * to be hidden has no effect on this chart type, and a bare row of
       * numbers that looked like magnitudes would be worse than a row that
       * is plainly labelled as bands.
       */
      axis: { x: 'Magnitude band, lowest to highest', y: 'Earthquakes' },
      legend: false,
    },
    {
      type: 'bar',
      x: 'day',
      y: 'count',
      title: 'Earthquakes recorded each day',
      axis: { y: 'Earthquakes', x: { labels: true, rotate: 'auto' } },
      legend: false,
    },
    {
      type: 'scatter',
      x: 'mag',
      y: 'depth',
      title: 'Depth against magnitude',
      axis: { x: 'Magnitude', y: 'Depth in kilometres' },
      legend: false,
    },
    {
      type: 'bar',
      x: 'net',
      y: 'count',
      title: 'Which network recorded them',
      axis: { y: 'Earthquakes', x: { labels: true } },
      legend: false,
    },
  ];

  chartSpecs.forEach((spec, index) => {
    try {
      built.charts.push(createChart({ grid: built.allGrid, container: chartBoxes[index], ...spec }));
    } catch (error) {
      chartBoxes[index].append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
      console.error('[earthquake demo] chart', spec.type, error);
    }
  });

  /* ---------------- the controls ---------------- */

  const button = (label, onClick, className) => {
    const node = el('button', className || 'action', label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  };

  const group = (ids) => () => built.allGrid && built.allGrid.columns.group(ids);

  actions.append(el('span', 'actions-label', 'Group by'));
  actions.append(button('PAGER alert', group(['alert'])));
  actions.append(button('Network', group(['net'])));
  actions.append(button('Day', group(['day'])));
  actions.append(button('Alert, then day', group(['alert', 'day'])));
  actions.append(button('No grouping', group([])));

  actions.append(el('span', 'actions-gap'));
  actions.append(el('span', 'actions-label', 'Order by'));
  actions.append(button('Newest first', () => built.allGrid && built.allGrid.sort.set([{ col: 'time', dir: 'desc' }])));
  actions.append(button('Largest first', () => built.allGrid && built.allGrid.sort.set([{ col: 'mag', dir: 'desc' }])));

  const notableButton = button(`Only M${NOTABLE_MAG} and above`, () => {
    const on = notableButton.getAttribute('aria-pressed') === 'true';
    /* A named row predicate: registering it is what activates it, and
       removing it by name leaves any other filter the reader has set
       untouched. */
    built.allGrid.filters.where('notable', on ? null : (row) => typeof row.mag === 'number' && row.mag >= NOTABLE_MAG);
    notableButton.setAttribute('aria-pressed', String(!on));
    notableButton.classList.toggle('on', !on);
  }, 'action toggle');
  notableButton.setAttribute('aria-pressed', 'false');
  actions.append(el('span', 'actions-gap'));
  actions.append(notableButton);
  built.notableButton = notableButton;

  /* These act on the All table, so they only belong on its tab. */
  const showActionsFor = (id) => {
    actions.hidden = id !== 'all';
  };
  showActionsFor(tabs.activeId);
  tabs.on('tab:changed', (event) => showActionsFor(event.id));

  /* ---------------- the live readout ---------------- */

  /**
   * Say when the data last moved, and say plainly when it stopped.
   *
   * @param {object} state what the poller reported
   */
  const setFreshness = (state) => {
    if (!meta.live) {
      const saved = new Date(meta.fetchedAt).toLocaleString('en-GB');
      const shifted = meta.shiftMs > 60000;
      freshness.textContent = state && state.replaying
        ? `Replaying a run saved on ${saved}, as though it were happening now`
        : shifted
          ? `A run saved on ${saved}, shown as though it were the last seven days`
          : `A run saved on ${saved}`;
      freshness.className = 'freshness';
      return;
    }
    if (built.status.lastError) {
      freshness.textContent = built.status.lastPoll
        ? `Could not reach the feed. Still showing what arrived at ${clockText(built.status.lastPoll)}.`
        : 'Could not reach the feed.';
      freshness.className = 'freshness failed';
      return;
    }
    if (!built.status.lastPoll) {
      freshness.textContent = 'Waiting for the first update...';
      freshness.className = 'freshness';
      return;
    }
    const revised = built.status.revisions;
    freshness.textContent =
      `Updated ${clockText(built.status.lastPoll)}. ` +
      `${commas(built.status.arrivals)} new, ${commas(revised)} revised since the page opened.`;
    freshness.className = 'freshness';
  };
  built.setFreshness = setFreshness;

  /**
   * Take a poll's result: apply it, refresh the figures and say so.
   *
   * @param {object} result what {@link startPolling} reported
   */
  built.onPoll = (result) => {
    built.status.lastPoll = result.fetchedAt || Date.now();
    built.status.lastError = null;
    built.status.polls += 1;
    liveDot.classList.add('beat');
    setTimeout(() => liveDot.classList.remove('beat'), 900);
    /*
     * The window rolls forward first, then the new earthquakes go in. That
     * is the right order on its own terms, and it also matters here: a row
     * the grid has removed stays in the rows it walks until the next change
     * reaches it, so doing the removals before the additions means the
     * additions settle it within the same poll rather than a minute later.
     */
    pruneWindow();
    ingest(result.rows);
    refreshFigures();
    setFreshness();
  };

  /**
   * Take a failed poll: keep the table, say what happened.
   *
   * @param {Error} error what went wrong
   */
  built.onPollError = (error) => {
    built.status.lastError = String((error && error.message) || error);
    setFreshness();
    console.warn('[earthquake demo] a poll failed:', built.status.lastError);
  };

  /* A hook for the verification script and for anyone poking at the page:
     push rows through exactly the path a poll uses. */
  built.ingest = ingest;

  setFreshness();
  refreshFigures();

  /* ---------------- the footer ---------------- */

  const footer = el('footer', 'foot');
  const line = el('p', null, 'Earthquake data from the ');
  const link = el('a', null, 'United States Geological Survey earthquake feeds');
  link.href = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php';
  link.rel = 'noopener';
  line.append(link);
  line.append(
    document.createTextNode(
      '. USGS data are in the public domain and free to use. Times are shown in your own time zone ' +
        'alongside UTC, which is what USGS publishes. Early readings are automatic and are revised ' +
        'by a reviewer, so a magnitude here may change.',
    ),
  );
  footer.append(line);
  root.append(footer);

  built.destroy = () => {
    clearInterval(clock);
    clearInterval(windowClock);
    for (const chart of built.charts) chart.destroy();
    kpi.destroy();
    router.destroy();
    tabs.destroy();
  };

  return built;
}
