# Ken Burns Studio Notes

## What This Tool Does
- Interactive UI for picking still images and defining Ken Burns style pans/zooms.
- Previews the motion locally before exporting clips.
- Exports either a full MP4 montage or a single representative frame through the backend.

## Frontend Overview (`public/app.jsx`)
- `App` fetches `/api/images`, holds per-image config, and orchestrates exports.
- Motion presets (`MOTION_PRESETS`) provide quick duration/zoom combos; selecting custom values flips the preset back to `custom`.
- `MainViewer` measures how the rendered image fits inside the viewport, converts pointer clicks to percentage coordinates, and runs a manual `requestAnimationFrame` loop so the preview easing matches exports.
- `ActiveAreaOverlay` shows the portion of the source image that will be visible at the chosen zoom level; `TargetMarker` drops a crosshair on the focus point.
- Footer controls adjust duration, zoom, motion style, fade duration, lock-zoom behavior, and trigger export actions.
- `handleExportVideo` POSTs the full plan to `/api/export-video`; `handleExportFrame` POSTs the same payload with `singleFrame` so the server renders only the midpoint frame; `handleExport` simply downloads the JSON plan for debugging.

## Backend Overview (`server.js`)
- Express server serves the static SPA, exposes API routes, and launches FFmpeg jobs.
- Key routes:
  - `GET /api/images`: lists files under `images/` so the UI can populate the gallery.
  - `POST /api/export-video`: regenerates frames into `temp/frames`, encodes per-image clips into `temp/clips`, then stitches them together (applying fades) into `public/exports/ken-burns-effect-<timestamp>.mp4`.
  - `POST /api/export-frame`: renders a single PNG to `public/exports/frame-<id>-<timestamp>.png` based on the requested progress point.
- `generateFramesForImage` mirrors the frontend transform logic, oversampling via `RENDER_OVERSAMPLE` (default 2x) before cropping/resizing with `sharp` to reduce ringing during zoom.
- `createClipFromFrames` feeds each PNG stack to FFmpeg, preferring `h264_nvenc` unless `USE_NVENC=false` or the encoder is missing (it then falls back to `libx264`).
- `combineClips` builds an `xfade` filter graph to apply per-image fades and concatenates the clips into the final video.
- Configuration knobs come from environment variables: `PORT`, `HOST`, `RENDER_OVERSAMPLE`, `NVENC_CODEC`, `NVENC_PRESET`, `NVENC_RATE_CONTROL`, `NVENC_CQ`, `X264_PRESET`, and `X264_CRF`. FFmpeg is expected at `C:\ffmpeg\bin\ffmpeg.exe` by default.

## File & Directory Layout
- `public/index.html`: loads React/ReactDOM from CDN and bootstraps `app.jsx` with Babel in the browser.
- `public/styles.css`: layout and overlay styling for the gallery, viewer, and crosshair.
- `images/`: drop source stills here; they are read directly when generating frames.
- `public/exports/`: final MP4s and one-off PNG exports land here (directory ensured on startup).
- `temp/frames` and `temp/clips`: scratch space recreated per export request; deleted automatically afterwards.
- `start-app.bat`: helper for launching the server locally on Windows.

## Typical Workflow
1. Run `npm install` (first time) and `npm start` / `node server.js` to launch the backend.
2. Browse to `http://127.0.0.1:3000` (server logs also mention the bound host).
3. Pick an image from the gallery, click on the viewer to set the focus target, and adjust duration/zoom/motion/fade in the footer.
4. Use **Preview Zoom** to validate the easing path; toggle **Stay zoomed** if you want the preview to remain at the final zoom level.
5. Export options:
   - **Export MP4**: kicks off the full render pipeline; watch the status text for progress and a download link.
   - **Render frame** (via `Export Frame` button): request a single PNG snapshot (currently mid-animation for ping-pong, end frame for zoom-in).
   - **Export** (JSON): download `ken-burns-plan.json` to archive/share the configuration.

## Troubleshooting & Notes
- If FFmpeg reports NVENC errors, the server logs warn and automatically retry with `libx264`.
- Oversampling increases RAM usage; set `RENDER_OVERSAMPLE=1` if renders are memory constrained.
- Intermediate `temp/` directories are cleared before and after each export; leftover folders are safe to delete manually.
- Constants such as `MIN_ARROW_LENGTH` and helpers like `distancePercent` remain for planned interactive tooling enhancements.
- The `/api/images` route appears twice in `server.js`; both definitions are identical and kept so the route documentation lives alongside each section header.
