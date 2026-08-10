# JupyterLite @ inf7

[![lite-badge](https://jupyterlite.rtfd.io/en/latest/_static/badge.svg)](https://jupyterlite.inf7.eu)

A [JupyterLite](https://jupyterlite.readthedocs.io) deployment: Jupyter notebooks that run
entirely in the browser, served as a static site from GitHub Pages. There is no kernel server and
no account: your notebooks and your data stay on your machine. Only the site itself and any
packages a notebook installs are fetched over the network.

## ✨ Try it in your browser ✨

➡️ **https://jupyterlite.inf7.eu**

## What's inside

The user interface is set to German (see [`overrides.json`](overrides.json)), and so is the prose
in the notebooks. Code, identifiers and code comments are English throughout.

### Kernels

| Kernel | Notes |
| --- | --- |
| Python (Pyodide) | CPython 3.14 compiled to WebAssembly, with `numpy`, `pandas`, `matplotlib` and friends |
| JavaScript | runs in a web worker |
| p5 | [p5.js](https://p5js.org) sketches in a notebook |

### Notebooks

- [`content/python.ipynb`](content/python.ipynb) — tour of the Pyodide kernel
- [`content/javascript.ipynb`](content/javascript.ipynb), [`content/p5.ipynb`](content/p5.ipynb) — the other two kernels
- [`content/sql.ipynb`](content/sql.ipynb) — **SQL in the browser** with [JupySQL](https://jupysql.ploomber.io) against a small SQLite library database
- [`content/pyodide/`](content/pyodide/) — plotting (`matplotlib`, `plotly`, `altair`, `bqplot`), maps (`folium`, `ipyleaflet`), widgets (`ipywidgets`, `ipycanvas`) and file renderers
- [`content/pyodide/pyb2d/`](content/pyodide/pyb2d/) — 2D physics tutorials and small games

### Extensions and libraries added on top of the template

| Package | What it adds |
| --- | --- |
| `jupyterlab-open-url-parameter` | opens a notebook from an external URL, see below |
| `jupyterlab-filesystem-access` | reads and writes files in a folder on your own disk, see below |
| `jupyterlab-language-pack-de-DE`, `-fr-FR`, `-uk-UA` | German, French and Ukrainian UI; German is the default in [`overrides.json`](overrides.json) |
| `jupyterlab-night` | dark theme |
| `jupyterlab-fasta`, `jupyterlab-geojson` | renderers for `.fasta` and `.geojson` files |
| `ipywidgets`, `ipyevents`, `ipympl`, `ipycanvas`, `ipyleaflet` | interactive widgets, event handling, interactive matplotlib, canvas drawing, maps |
| `plotly`, `bqplot` | plotting libraries |

Everything else — `numpy`, `pandas`, `matplotlib`, `sympy` and the rest of the Pyodide
distribution — is available in the Python kernel via `%pip install <package>` at runtime.

### Extensions that are switched off

[`repl/jupyter-lite.json`](repl/jupyter-lite.json) lists `@jupyterlab/drawio-extension`,
`jupyterlab-kernel-spy` and `jupyterlab-tour` under `disabledExtensions`, which switches them off
in the REPL app whether or not they are installed. They stay on that list on purpose, as a standing
note that they are currently not compatible — removing a package from `requirements.txt` is not a
reason to remove it there.

### Opening a notebook from an external URL

`jupyterlab-open-url-parameter` adds the `fromURL` query parameter. Append it to the site URL and
the file is downloaded into the file browser and opened:

```
https://jupyterlite.inf7.eu/lab/index.html?fromURL=https://example.org/aufgabe.ipynb
```

`fromURL` may be repeated to open several files at once (a notebook plus its data file, say), and
`&fromURLToFolder=uebungen` drops them into a folder, which is created if it does not exist.
The URL has to be reachable by the browser and allow cross-origin requests: GitHub links of the
`raw.githubusercontent.com` kind work, links to the GitHub HTML page do not.

### Working with files on your own disk

`jupyterlab-filesystem-access` adds a second file browser to the left sidebar, labelled *Local File
System*. Pick a folder there and the browser asks once for permission; afterwards notebooks in that
folder open, run and save directly on your disk, with no upload and no download step in between.

This uses the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API),
which currently only exists in **Chromium-based browsers** (Chrome, Edge, Opera, Brave). In Firefox
and Safari the rest of the site works, but this panel does not — there you use upload and download,
or the `fromURL` parameter above.

### The SQL example

[`content/sql.ipynb`](content/sql.ipynb) writes plain SQL in `%sql` / `%%sql`
cells. The example database is a small children's library — `authors`, `books`, `members`,
`loans` — shipped as [`content/data/library.db`](content/data/library.db) and reproducible from
[`content/data/library.sql`](content/data/library.sql):

```bash
cd content/data && sqlite3 library.db < library.sql
```

JupySQL is not part of the build environment; the notebook installs it into the kernel at runtime
with `%pip install jupysql`. Queries read `data/library.db` straight out of the file browser.

The querying half of the notebook deliberately runs without `pandas`, so a beginner working through
plain SQL never downloads it. `pandas` — and with it `matplotlib` — is pulled in only from the
chapter that turns a result into a DataFrame, and that chapter says so.

Writing is the one thing that does not work there: the file browser is backed by browser storage,
which SQLite cannot write to safely — an `INSERT` leaves the database reporting *database disk
image is malformed*. The notebook therefore copies the database to `/tmp` before the chapter that
writes, and says so. Verified end to end in Chromium against the built site.

## Build it locally

```bash
python -m pip install -r requirements.txt
cp README.md content
jupyter lite build --contents content --output-dir dist
python -m http.server -d dist            # then open http://localhost:8000
```

Serving `dist` over HTTP matters: opened as a `file://` URL, the service worker that gives kernels
access to the file browser is not available.

## Deployment

Every push to `main` triggers [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which
builds the site and publishes it to GitHub Pages. Pull requests build too, but do not deploy.

Two things have to be in place for that to work:

- **Pages must be enabled with *GitHub Actions* as the publishing source.** Without it the build
  step still succeeds and only the deploy step fails, with `Ensure GitHub Pages has been enabled`.
- **DNS must point at GitHub.** `jupyterlite.inf7.eu` needs a `CNAME` record to `<user>.github.io`,
  or the four `185.199.10x.153` A records.

The custom domain itself comes from [`CNAME`](CNAME), which the workflow copies into the build
output — deploying that artifact registers the domain under **Settings → Pages → Custom domain**,
so it does not have to be entered by hand.

## Browsers

JupyterLite is tested against modern browsers:

- Chromium 89+ (Chrome, Edge, Opera, Brave) — **recommended**, and the only family in which the
  local filesystem panel works
- Firefox 90+ — everything except the local filesystem panel

## Further reading

- JupyterLite documentation: https://jupyterlite.readthedocs.io
- How-to guides: https://jupyterlite.readthedocs.io/en/latest/howto/index.html
- Adding Python packages: https://jupyterlite.readthedocs.io/en/latest/howto/pyodide/packages.html

Built from the [`jupyterlite/demo`](https://github.com/jupyterlite/demo) template. See
[`requirements.txt`](requirements.txt) for every extension and kernel that goes into the build.
