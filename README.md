# Gem — Tableau Workbook Explorer (offline)

![Static site badge](https://img.shields.io/badge/Static%20site-Yes-8B5CF6?style=flat-square)
![Runs offline badge](https://img.shields.io/badge/Runs%20offline-100%25-22c55e?style=flat-square)

## 1. Overview

Gem lets you drop a Tableau `.twb` or `.twbx` workbook into the browser and explore it without
sending data anywhere. The app parses workbooks client-side, builds a lineage graph, and lets you
inspect sheets, dashboards, fields, and parameters through a Cytoscape visualization. You can also
export structured documentation that captures formulas and "where used" relationships for later
reference.

Gem is built for secure environments. It makes zero network calls, stores everything in memory, and
works entirely offline so it can run inside air-gapped or DoD networks.

## 2. Quick start

1. Download this repository or clone it locally.
2. Double-click `index.html` (or open it via `file://`) to run Gem locally.
3. Alternatively, host the repository with GitHub Pages and open the deployed `index.html`.
4. Drag in a Tableau workbook or click **Open Workbook**.

Supported files: Tableau `.twb` (XML) and `.twbx` (packaged) workbooks.

## 3. Using the app

- **Open a workbook**: Click **Open Workbook** (`openBtn`) or drag a file onto the drop zone
  (`dropZone` / `fileInput`).
- **Search**: Type in the search box (`search`). Press **Enter** to jump to the best match and
  **Esc** to clear the field.
- **Layouts**:
  - **Fit** (`fitBtn`) zooms to the currently visible nodes.
  - **Auto layout** (`layoutBtn`) re-runs the force layout for a quick refresh.
  - **Layout menu** (`layoutDropdown` / `layoutMenu` / `layoutMenuBtn`):
    - **Force**: physics simulation for organic positioning after big updates.
    - **Grid**: tidy rows/columns for scanning long lists of nodes.
    - **Hierarchy**: breadth-first layout that arranges dashboards up top, then sheets, then their dependencies.
    - **Centered hierarchy**: concentric rings by type for overview diagrams.
    - **Centered from selection**: centers on the active node to study its neighborhood.
- **Hops ▾** (`hopBtn` / `hopMenu`): Choose 1–5 hops from the pill dropdown to expand neighbors around the selection.
- **Isolated nodes** (`isolatedBtn` / `isolatedMenu`):
  - **Hide** removes detached nodes from view.
  - **Cluster** packs isolated nodes into a compact grid for review.
  - **Scatter** restores isolated nodes but keeps them separated.
  - **Unhide** shows everything, respecting current filters.
- **Filters** (`filters-dropdown`): Toggle node types (Fields, Calculated, Worksheets, Dashboards,
  Parameters) plus **LOD only** and **Table Calcs only** views for calculated fields.
- **Theme** (`themeBtn`): Switch between Dark and Light themes for the current session.
- **Drag/Zoom**: Pan with the mouse, scroll to zoom, and drag nodes to adjust their placement.

### Hop selector

- The hop control is now a pill-style dropdown labeled **Hops ▾**, consistent with the rest of the toolbar pills.
- Selecting 1–5 hops sets the neighbor expansion depth that Gem uses when you expand around the current selection.

### Hierarchy layout (pyramid)

- The **Hierarchy** layout arranges nodes from top to bottom:
  - **Level 0:** Dashboards (roots)
  - **Level 1:** Worksheets
  - **Level 2+:** Fields, Calculated Fields, Parameters
- Ranks are separated vertically so the lineage reads as a pyramid instead of a long horizontal snake.
- If no dashboards are visible (for example after filtering), Gem automatically uses worksheets as the roots.

### Details panel

The right-hand `details` pane mirrors the selected node, showing its type, datasource, and any
related worksheets or dashboards so you can trace dependencies without leaving the graph.

#### Formula display

Formulas render inside a `<pre>` block as plain text, so Tableau syntax like `<` and `>` stays
visible and any user-authored HTML is escaped automatically. The Formula heading displays **LOD** and
**Table Calc** chips whenever the expression uses `{}` level-of-detail braces, the table-calculation
flag is set, or `WINDOW_`/`RUNNING_` keywords appear. Long expressions wrap, break on extended tokens,
and scroll inside a 240px container, keeping every character legible without overflowing the panel.

## 4. Exports

- `workbook_doc.json`: Structured metadata for the full workbook (fields, calculated fields,
  sheets, dashboards, parameters).
- `graph.json`: Nodes and edges used in the Cytoscape graph visualization.
- `workbook_doc.md`: Human-readable Markdown with formulas, references, and where-used details.
- `lineage.dot`: Graphviz DOT you can render to PNG/SVG lineage diagrams.

To export, open **Export ▸** and choose a format. The file downloads locally; nothing leaves your
browser.

## 5. UI reference (Button & control table)

| Control | ID or Label | What it does | Notes/Shortcuts |
| --- | --- | --- | --- |
| Open Workbook | `openBtn` | Launches the workbook picker. | Drop files onto `dropZone`. |
| Fit | `fitBtn` | Fits visible graph elements. | Press `f` while focus is outside inputs. |
| Auto layout | `layoutBtn` | Replays the force layout. | Helpful after filters or hop changes. |
| Layout menu | `layoutDropdown`[^layout-ids] | Preset layouts[^layout-menu]. | Runs immediately. |
| Hop selector | `hopBtn` / `hopMenu` | Sets neighbor hop count. | Values 1–5; mirrors last expansion. |
| Isolated nodes | `isolatedBtn`[^isolated-ids] | Modes[^isolated-note]. | Menu toggles. |
| Filters | `filters-dropdown` | Filters[^filters-note]. | Combine toggles to narrow the graph. |
| Export | `export-dropdown` | Download workbook exports[^export-note]. | Browser download flow. |
| Theme | `themeBtn` | Toggles Dark/Light theme. | Choice persists while the tab stays open. |

[^layout-menu]: Options: Force, Grid, Hierarchy, Centered, Centered-from-selection.
[^layout-ids]: Related controls: `layoutMenuBtn`, `layoutMenu`.
[^isolated-note]: Modes: Hide, Cluster, Scatter, Unhide.
[^isolated-ids]: Dropdown container: `isolatedMenu`.
[^filters-note]: Fields, Calcs, Sheets, Dashboards, Parameters, LOD/Table Calc views.
[^export-note]: Files: `workbook_doc.json`, `graph.json`, `workbook_doc.md`, `lineage.dot`.

## 6. Panels & details

- **Sidebar tabs**: `panel-nodes`, `panel-sheets`, `panel-calcs`, and `panel-params` list the
  corresponding workbook items (`list-nodes`, `list-sheets`, `list-calcs`, `list-params`). Clicking
  an entry focuses the node in the graph.
- **Details panel**: The `details` pane shows the selected node’s type, datasource, formulas, and
  related worksheets or dashboards. Calculated fields include flags (LOD/Table Calc) and references.

## 7. How it works (for developers)

The runtime flows from parsing to rendering:

1. Parse the uploaded workbook (`parseWorkbookFile` → `parseFromXmlDocument`).
2. Build a normalized node/edge model (`buildGraph`).
3. Initialize Cytoscape once (`bootGraph`), then redraw via `drawGraph`.
4. React to UI actions (`bindUI`): filters, layouts, hops, isolation, theme.
5. Export serializers (`buildMarkdown`, `buildDot`, and JSON builders) format downloads on demand.

File map:

- `index.html`: Layout, toolbar controls, panels, and script tags. No build tooling required.
- `styles.css`: Theme tokens (purple/gray palette) and styles for top bar, sidebar, graph, and
  details.
- `app.js`: Parsing, data model construction, Cytoscape initialization, UI wiring, and export
  helpers.
- `lib/*`: Bundled third-party libraries (JSZip, Cytoscape, layout extensions).

Data types:

- **Node**: `{ id, name, type }` with `type` values `Field`, `CalculatedField`, `Worksheet`,
  `Dashboard`, `Parameter` plus additional metadata (datasource, formulas, usage).
- **Edge**: `{ id, source, target, rel }` using relationship names such as `FEEDS`, `PARAM_OF`,
  `USED_IN`, and `ON` to describe lineage.
- **Workbook graph**: `{ nodes: Node[], edges: Edge[] }` consumed by Cytoscape.

## 8. Developing & contributing

- **Prerequisites**: None. Open `index.html` directly in a modern browser.
- **Coding standards**: Use JSDoc for functions, avoid renaming existing IDs, and preserve ARIA
  attributes when editing menus and panels.
- **Extending layouts**: Add new layouts beside `runForceLayout`, `runGridLayout`, and friends in
  `app.js`, then wire them into `layoutMenu`.
- **New exports**: Extend the switch in the export handler, reusing patterns from `buildMarkdown`,
  `buildDot`, and `downloadBlob`.

### Development notes

- **Graph normalization**: Before rendering, uploaded workbook graphs are sanitized to guarantee
  Cytoscape receives well-formed elements. Each node is rebuilt with `data.id`/`data.name`, duplicate
  node IDs are dropped, edges pointing to unknown nodes are skipped, and any omissions trigger
  console warnings so issues are easy to trace. This prevents Cytoscape runtime crashes when workbooks
  contain malformed relationships.

## 9. Troubleshooting

- `.twbx` files fail to open: Check the browser console for parsing errors and confirm the file
  isn’t blocked by the browser’s size limits.
- Graph uploads but nothing renders: Open the console for validation errors. Gem enforces Tableau
  internal IDs (`Calculation_…`, `Field_…`, `Worksheet_…`) as node IDs and rejects edges that point to
  missing nodes. If you edit XML manually, keep those IDs intact—only the friendly captions should
  change.
- Brand logo missing on GitHub Pages: Use the hosted path `/Gem/assets/gem-logo.png` or the relative
  `./assets/gem-logo.png` when serving from a custom domain.

## 10. Name resolution

Gem builds lookup tables after parsing a workbook that map Tableau's internal identifiers (for
fields, calculations, parameters, sheets, dashboards, and datasources) to the friendly captions that
appear in the UI. The Cytoscape nodes and sidebar use those human-readable names, while the original
IDs remain available as tooltips on the details heading, datasource line, and reference lists. Hover
those elements any time you need to verify the underlying Tableau identifier while keeping the
visualization approachable.

## 11. License

This project uses the MIT License. Cytoscape.js and JSZip remain MIT licensed (see `LICENSE.md`).
