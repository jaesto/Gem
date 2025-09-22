# Tableau Workbook Explorer (MVP)

An offline, client-side viewer that parses Tableau `.twb` and `.twbx` workbooks in the browser. Drop a workbook into the app to explore lineage through an interactive graph, review calculated fields, and export auto-generated documentation artifacts.

## Features

- Runs entirely in the browser (no servers, no telemetry, no network access required)
- Supports Tableau `.twb` (XML) and `.twbx` (packaged) files
- Interactive Cytoscape graph with pan/zoom/drag, neighbor expansion, and search
- Node labels automatically adjust contrast per theme, truncate with ellipses, and expose full names on hover
- Layout "breathes" after major actions (load, fit, auto layout, expand neighbors, filters, isolated mode changes) and when
  hovering or tapping nodes; when zoomed out the labels hide until there's room, but hovering always reveals the name
- Sidebar lists for fields, calculated fields, worksheets, and parameters
- Detail panel with formulas, references, and usage
- Filter controls for node types, LOD-only, and table-calculation-only views
- Exportable artifacts: `workbook_doc.json`, `graph.json`, `workbook_doc.md`, and `lineage.dot`

## Branding & Theming

- Dark-first design tokens live in `styles.css` as CSS custom properties such as:
  - `--gem-bg`, `--gem-surface`, `--gem-surface-2`
  - `--gem-text`, `--gem-muted`
  - `--gem-primary`, `--gem-primary-2`, `--gem-primary-3`, `--gem-accent`
  - `--gem-success`, `--gem-warning`
  - Utility tokens: `--gem-border`, `--gem-shadow`, `--gem-glow`, `--radius`, `--radius-lg`, `--pad`, `--trans`
- The header logo first attempts to load `./assets/gem-logo.png`; if unavailable it falls back to the inline SVG contained in `index.html` so the app remains binary-free by default.

## Toolbar

- Slim single-line toolbar with logo on the left, centered search, and controls on the right sized for a compact 42px header.
- Hop dropdown (1–5) replaces expand1/2 buttons.

## Getting started

### Run locally

1. Clone or download this repository.
2. Open `site/index.html` directly in your browser (double-click from Finder/Explorer or use `file://`).
3. Drag a Tableau `.twb` or `.twbx` onto the drop zone, or use **Open Workbook**.

No build step is required; everything is bundled for offline use.

### Using the app

1. Drop or open a Tableau workbook.
2. Explore the graph with pan, zoom, drag, and neighbor expansion buttons.
3. Filter by node type, or show only LOD/table-calculation nodes.
4. Use the search box (press `/` to focus, `f` to fit) to jump to a node.
5. Select a node to inspect formulas, references, and usage in the detail panel.
6. Export documentation via **Export →** `workbook_doc.json`, `graph.json`, `workbook_doc.md`, or `lineage.dot`.

### Publish with GitHub Pages

1. Push this repository to GitHub.
2. Enable GitHub Pages on the repository (Settings → Pages) and choose the **main** branch with the root folder.
3. The provided workflow (`.github/workflows/pages.yml`) publishes the `site/` folder automatically on each push to `main`.

## Security & privacy

- 100% offline: all parsing, graphing, and exports happen client-side in the browser.
- No external CDNs: Cytoscape.js and JSZip are bundled locally under `site/lib/`.
- No analytics, telemetry, or network requests.

## Repository layout

```
tableau-browser-mvp/
├─ .nojekyll
├─ README.md
├─ LICENSE.md
├─ CHANGELOG.md
├─ SECURITY.md
├─ site/
│  ├─ index.html
│  ├─ styles.css
│  ├─ app.js
│  └─ lib/
│     ├─ cose-base.js
│     ├─ cytoscape-cose-bilkent.min.js
│     ├─ cytoscape.min.js
│     ├─ jszip.min.js
│     └─ layout-base.js
└─ .github/workflows/pages.yml
```

A `site/data/` directory is created at runtime for downloaded artifacts (not tracked in Git).

## Keyboard shortcuts

- `/` – focus the search box
- `f` – fit the graph to the visible elements

## License

This project is released under the MIT License. Cytoscape.js and JSZip are bundled locally and retain their MIT licenses (see `LICENSE.md`).
