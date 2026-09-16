# Earthquakes around the world, as they are recorded

A live dashboard of every earthquake the United States Geological Survey has recorded in the last seven days, built on Lattice Grid and reading the USGS feeds directly from the browser.

**[See it running](https://toclocoinc.github.io/lattice-grid-demo-earthquakes/)**

| | |
| --- | --- |
| Grid on npm | [@toclocoinc/lattice-grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) |
| This demo | [toclocoinc/lattice-grid-demo-earthquakes](https://github.com/toclocoinc/lattice-grid-demo-earthquakes) |
| Product site | [latticegrid.dev](https://www.latticegrid.dev) |

## What it shows

One arriving stream of data with several views on it: a table, a second table of the significant events, a strip of headline figures and four charts. They all read the same stream, so narrowing the table moves everything else with it.

The point of the demo is what happens after the first load. USGS publishes an automatic reading within a minute or two of an earthquake, then a seismologist reviews it, and the magnitude and the place are corrected for hours afterwards. The page polls for those corrections every minute and lands each one on the row it belongs to, rather than adding a second row for the same earthquake. When a magnitude changes, the cell lights up.

**A rolling window.** The table keeps the last seven days and no more. The window is measured against each earthquake's own timestamp rather than against the moment its row arrived, and it rolls forward on a timer, so an event ages out of the table whether or not anything new has come in.

**Corrections in place.** Each poll is a set of upserts keyed on the USGS event id. A revised magnitude replaces the one on the row. The feed stamps every revision with the moment it was made, and the page uses that stamp as its ordering clock, so an older copy of a row arriving late cannot undo a correction that has already landed.

**Two datasets, not one filtered twice.** The significant tab reads a different feed, which reaches back a month. It holds earthquakes the seven day window has already dropped, so narrowing the first table could never produce it.

**Figures that follow the table.** The tiles across the top read whatever the table currently matches. Turn on "Only M4.5 and above" and the counts, the charts and the tiles all move together.

**A feed that can fail.** If a poll cannot reach USGS the page says so and keeps showing what it already had, rather than emptying itself. If the feeds cannot be reached at all when the page opens, it shows the saved copy that ships with the demo and says so at the top.

## Running it

You need Node. Nothing is compiled and there is no build step.

```
npm install
npm start
```

The server prints the address to open, for example `http://localhost:41234/`. It picks a free port each time so it will not clash with anything else you have running.

| Address | What you get |
| --- | --- |
| `/` | live, reading the USGS feeds and polling every minute |
| `/?source=snapshot` | the saved copy in `data/snapshot`, no network needed |
| `/?source=snapshot&replay=1` | the saved copy fed in over time, so it moves offline |

The saved copy lives in `data/snapshot/` and records the date and time it was fetched. It is shown as though its newest event had just arrived, so the seven day window is never empty however long ago the file was built; the page says so under the title. To take a fresh one:

```
npm run snapshot
```

## The single file version

`preview.html` is the whole dashboard in one file, with the saved data written into the page. Open it straight from disk, with no server. It still needs to reach the internet to load the grid itself. Rebuild it after taking a new snapshot:

```
npm run preview
```

It refuses to write anything unless every library file it points at answers 200 from the CDN and is byte for byte identical to the copy installed locally.

## Where the data comes from

The [USGS earthquake feeds](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php), which publish every earthquake recorded worldwide as GeoJSON, regenerated every minute. The page reads three of them directly from your browser, with no server in the middle:

- <https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson> when the page opens, for the seven day window
- <https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson> when the page opens, for the significant tab
- <https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson> every minute after that, for new events and revisions

A few things worth knowing when you read the numbers.

Times in the feed are UTC. The table shows your local time and the UTC time side by side, because every figure USGS publishes is UTC.

Depth is in kilometres and comes from the third GeoJSON coordinate. The first two are longitude then latitude, in that order.

`alert` is the PAGER level and is only present once an event has been assessed, which is a small minority of them. Unassessed events are shown as "Not assessed" rather than being hidden. `felt`, `cdi` and `mmi` come from public reports and are absent until somebody files one.

A magnitude is `null` on a handful of records, so nothing assumes it is a number.

## Files

```
index.html                page shell
main.js                   works out where the data comes from, then starts
src/licence.js            the key for the demo's own published address
src/usgs-feed.js          the feeds: fetching, parsing, polling, replay
src/dashboard.js          the views: router, tables, tiles, charts, tabs
styles.css                the page around the grid
tools/serve.mjs           a small static file server
tools/build-snapshot.mjs  save a real run into data/snapshot
tools/build-preview.mjs   build the single file preview
tools/verify.mjs          open it in a real browser and check it
data/snapshot/            a saved run, so the demo works with no network
```

## Checking it

```
npm run verify            # the saved copy, and the fallback with the feeds blocked
npm run verify -- --all   # also the live feeds and preview.html from disk
```

`npm run verify` needs Node 22 and a Chrome or Chromium on the machine. It is not a smoke test: it recomputes the headline figures from the saved feed data and compares them with what the page is showing, narrows the table and insists the tiles and charts moved with it, pushes a revised magnitude through and insists the row count did not change, and pushes two rows of different ages and insists the window kept one and dropped the other. It then blocks the USGS feeds in the browser, opens the live page, and insists the saved copy is on screen and says why. It never needs the internet, so it gates the deployment. `--all` adds the live feeds and the single file preview, which do.

## Licence

The code in this repository is available under the MIT licence. See [LICENSE](LICENSE).

Lattice Grid itself is a separate commercial product with its own terms. It is free to use on localhost, with no key and no watermark, so a copy of this repository runs unrestricted on your own machine. This demo carries a key for its own published address only, which is why you will find one in the source. Keys for your own sites come from [latticegrid.dev](https://www.latticegrid.dev).

The earthquake data comes from the [United States Geological Survey earthquake feeds](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php). USGS data are in the public domain and free to use.
