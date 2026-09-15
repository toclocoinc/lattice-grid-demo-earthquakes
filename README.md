# Earthquakes around the world, as they are recorded

A live dashboard of every earthquake the United States Geological Survey has
recorded in the last seven days, built on Lattice Grid.

It is one arriving stream of data with several views on it: a table, a second
table of the significant events, a strip of headline figures and four charts.
They all read the same stream, so narrowing the table moves everything else
with it.

The point of the demo is what happens after the first load. USGS publishes an
automatic reading within a minute or two of an earthquake, then a seismologist
reviews it, and the magnitude and the place are corrected for hours
afterwards. The page polls for those corrections every minute and lands each
one on the row it belongs to, rather than adding a second row for the same
earthquake. When a magnitude changes, the cell lights up.

## Running it

```
npm install
npm start
```

That prints an address. Open it.

| Address | What you get |
| --- | --- |
| `/` | live, reading the USGS feeds and polling every minute |
| `/?source=snapshot` | the saved copy in `data/snapshot`, no network needed |
| `/?source=snapshot&replay=1` | the saved copy fed in over time, so it moves offline |
| `preview.html` | everything in one file, openable straight from disk |

Running a copy on your own machine needs no licence key. Publishing it on a
web address does.

## What it shows

**A rolling window.** The table keeps the last seven days and no more. The
window is measured against each earthquake's own timestamp rather than against
the moment its row arrived, and it rolls forward on a timer, so an event ages
out of the table whether or not anything new has come in.

**Corrections in place.** Each poll is a set of upserts keyed on the USGS
event id. A revised magnitude replaces the one on the row. The feed stamps
every revision with the moment it was made, and the page uses that stamp as
its ordering clock, so an older copy of a row arriving late cannot undo a
correction that has already landed.

**Two datasets, not one filtered twice.** The significant tab reads a
different feed, which reaches back a month. It holds earthquakes the seven day
window has already dropped, so narrowing the first table could never produce
it.

**Figures that follow the table.** The tiles across the top read whatever the
table currently matches. Turn on "Only M4.5 and above" and the counts, the
charts and the tiles all move together.

**A feed that can fail.** If a poll cannot reach USGS the page says so and
keeps showing what it already had, rather than emptying itself.

## The data

Everything comes from the USGS earthquake feeds:

- <https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php>

The page reads the past week summary and the past month of significant
earthquakes when it opens, then polls the past day summary each minute. USGS
regenerates each of those files every minute and serves them with open
cross-origin headers, so the browser reads them directly and there is no
server in the middle.

USGS data are in the public domain and free to use.

A few things worth knowing about the data:

- Times in the feed are UTC. The table shows your local time and the UTC time
  side by side, because every figure USGS publishes is UTC.
- Depth is in kilometres and comes from the third GeoJSON coordinate. The
  first two are longitude then latitude, in that order.
- `alert` is the PAGER level and is only present once an event has been
  assessed, which is a small minority of them. Unassessed events are shown as
  "Not assessed" rather than being hidden.
- `felt`, `cdi` and `mmi` come from public reports and are absent until
  somebody files one.
- A magnitude is `null` on a handful of records, so nothing assumes it is a
  number.

## Files

```
index.html                page shell
main.js                   works out where the data comes from, then starts
src/usgs-feed.js          the feeds: fetching, parsing, polling, replay
src/dashboard.js          the views: router, tables, tiles, charts, tabs
styles.css                the page around the grid
tools/serve.mjs           a small static file server
tools/build-snapshot.mjs  save a real run into data/snapshot
tools/build-preview.mjs   build the single file preview
tools/verify.mjs          open it all in a real browser and check it
data/snapshot/            a saved run, so the demo works with no network
```

The saved copy is shown as though its newest event had just arrived, so the
seven day window is never empty however long ago the file was built. The page
says so under the title.

## Checking it

```
npm run snapshot   # save a fresh run from the live feeds
npm run preview    # rebuild preview.html
npm run verify     # open all three modes in a real browser and assert
```

`npm run verify` is not a smoke test. It recomputes the headline figures from
the saved feed data and compares them with what the page is showing, narrows
the table and insists the tiles and charts moved with it, pushes a revised
magnitude through and insists the row count did not change, and pushes two
rows of different ages and insists the window kept one and dropped the other.

`npm run preview` refuses to write anything unless every library file it
points at answers 200 from the CDN and is byte for byte identical to the copy
installed locally.

## Licence

The demo code is MIT. See `LICENSE`.

The earthquake data is from the United States Geological Survey and is in the
public domain.

Lattice Grid itself is a commercial product with its own licence.
