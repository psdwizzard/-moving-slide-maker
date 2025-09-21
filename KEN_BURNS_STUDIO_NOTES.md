# Ken Burns Studio Notes

## What This Tool Does
- Interactive UI for sequencing still images and defining Ken Burns style pans/zooms per slide.
- Supports named projects that persist manifest data, clip renders, and combined MP4 outputs.
- Provides multiple export scopes (all clips, missing clips, explicit ranges) plus a manifest refresh button for manual file updates.
- Mirrors final easing/transform math in the browser so previews match the encoded output.

## Frontend Overview (`public/app.jsx`)
- `App` bootstraps source imagery (`/api/images`), project metadata (`/api/projects`), defaults (`/api/settings`), and tracks state such as `projectSlug`, `images`, `imageConfigs`, `exportScope`, and `exportRange`.
- **Project Controls**
  - Project name is required before exporting; `Browse Projects` opens a panel of saved manifests.
  - **Update Project** calls `/api/projects/:slug/refresh-manifest`, re-scaning `output/<slug>/images` and `/clips` to synchronise clip presence.
  - `exportScope` dropdown lets the user choose `all`, `missing`, or `range`; range mode accepts 1-based values like `1-4,6`.
- Gallery entries display a `clipFile` badge so “Clip done” in the viewer reflects actual manifest data.
- `MainViewer` measures how an image fits inside the stage, converts pointer clicks to percentage coordinates, and uses a manual `requestAnimationFrame` loop to mirror easing curves. It also exposes **Preview Zoom**, **Clear Target**, **Regenerate Clip**, a read-only clip status checkbox, and a **Continue** button that jumps to the next unfinished slide.
- Footer controls adjust duration, zoom, motion style, fade, and lock-zoom options. `handleExportVideo` composes the payload with scope metadata; `handleExportFrame` renders a single frame; `handleExport` downloads the JSON plan for debugging.

## Backend Overview (`server.js`)
- Express serves the SPA and exposes JSON APIs.
- Key routes:
  - `GET /api/images` — returns the gallery manifest, filtering to supported image extensions and exposing `clipFile` when available.
  - `GET /api/settings` / `POST /api/settings/default-config` — load and persist default slide settings and alternating auto-motion state.
  - `GET /api/projects` — list saved project manifests with summary metadata.
  - `GET /api/projects/:slug` — fetch a project's manifest.
  - `POST /api/projects/:slug/refresh-manifest` — rescan `output/<slug>` to sync images/clips after manual edits.
  - `POST /api/projects/:slug/regenerate-clip` — re-render a single clip and rebuild the combined montage.
  - `POST /api/export-video` — render clips according to the requested scope, caching new renders in `output/<slug>/clips/clip-<index>.mp4`, reusing existing clips when possible, then combining them into the final MP4.
  - `POST /api/export-frame` — render a single PNG snapshot for inspection.
- `generateFramesForImage` mirrors frontend transform math, oversampling via `RENDER_OVERSAMPLE` (default `2`) to keep zooms crisp.
- `createClipFromFrames` encodes PNG stacks with FFmpeg, preferring `h264_nvenc` (fallback `libx264` when hardware support is missing).
- `combineClips` builds an `xfade` filter graph, applying fades and stitching clips into the final video placed under `public/exports/`.
- `cleanupFramesForIndex` and post-encode logic remove PNG batches and temporary MP4s immediately, preventing disk exhaustion.
- `refreshProjectManifest` rebuilds manifests by scanning disk, preserving per-slide config when present, ignoring non-image files (e.g. `.gitkeep`), and re-associating `clip-<index>.mp4` files.

## File & Directory Layout
- `public/index.html` — bootstraps React/ReactDOM (via CDN) and loads `app.jsx` through Babel.
- `public/styles.css` — layout, gallery, viewer, overlay, toolbar, and export UI styles.
- `images/` — ingestion folder; source stills placed here are surfaced in the gallery unless they are `.gitkeep`/unsupported formats.
- `output/<project>/`
  - `manifest.json` — saved project state.
  - `clips/clip-<index>.mp4` — individual clip renders stored during exports/regenerations.
  - `<project>.mp4` or similar — combined montage, copied alongside the manifest.
  - `images/` — project-local copies of source stills once a project is created.
- `public/exports/` — combined MP4s and on-demand PNG frames (directory ensured on startup and exposed over HTTP).
- `temp/frames` + `temp/clips` — scratch directories recreated per export/regeneration and cleaned automatically.
- `output/settings.json` — persisted default slide settings and alternating auto-motion pointer.
- `.gitkeep` placeholders live in ignored directories to keep them present without committing renders.

## Typical Workflow
1. `npm install` (first run) then `npm start` / `node server.js` to boot the backend.
2. Visit `http://127.0.0.1:3000`, select or create a project name, and queue images from the gallery.
3. Click the viewer to define focus targets (or leave blank to use the alternating auto-focus fallback), adjust duration/zoom/fade/motion, and optionally **Save as Default** for future slides.
4. Use **Preview Zoom** to validate motion; **Regenerate Clip** updates an existing slide without re-rendering the entire project.
5. Choose an export scope:
   - **All** — render every slide.
   - **Missing** — render only slides lacking MP4s.
   - **Range** — render 1-based indices/ranges (e.g. `1-4,6`); missing clips are always included.
   Hit **Export MP4** to kick off the appropriate workflow; status text reports progress and completion.
6. If clips or images are added/removed manually in `output/<project>`, press **Update Project** to rescan the directory and refresh the manifest/Gallery UI.
7. Use **Export JSON** for plan hand-off or debugging, and **Export Frame** for a quick focus preview.

## Troubleshooting & Notes
- Disk pressure: PNG batches are deleted immediately after each clip render and the temporary MP4 is removed once copied into `output/<project>/clips/`.
- Export scope logs indicate whether clips are reused or re-rendered (e.g., “Reusing existing clip for image N”).
- `SUPPORTED_IMAGE_EXTENSIONS` ensures `.gitkeep` and other non-media files are ignored during refresh.
- If NVENC hardware encoding fails, the server automatically falls back to `libx264` and logs a warning.
- Set `RENDER_OVERSAMPLE=1` to reduce memory usage during frame generation.
- Temporary directories are recreated per export; it is safe to delete `temp/` if a run aborts.
- Constants like `MIN_ARROW_LENGTH` remain for future interactive tooling enhancements.
