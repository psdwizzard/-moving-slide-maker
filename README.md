# Moving Slide Maker

Moving Slide Maker is a Ken Burns style slideshow tool that lets you define per-image motion paths, preview them in the browser, and export named projects as MP4 montages.

## Features
- Web UI for selecting source images, adjusting duration/zoom/fade, and setting focus targets with live previews.
- Named projects: supply a project title before exporting to archive per-slide clips and the combined MP4 under `output/<project>/`.
- Saved defaults: capture your favorite motion settings once and reuse them for new slides.
- Project browser with one-click clip regeneration when you replace or tweak a single image.
- Automatic focus fallback that alternates between center zoom-in and zoom-out when you skip manual targeting.
- Backend pipeline renders oversampled frames with Sharp and assembles clips with FFmpeg (NVENC support included for fast GPU encoding).

## Getting Started
1. Install dependencies:
   ```bash
   npm install
   ```
2. Make sure FFmpeg is available at `C:\ffmpeg\bin\ffmpeg.exe` or set the `FFMPEG_PATH` env var before starting the server.
3. Launch the app:
   ```bash
   npm start
   ```
4. Visit `http://127.0.0.1:3000`, pick a project name, and begin defining motion paths.

## Project Workflow
- **Export MP4** requires a project name; as each clip finishes encoding it is copied into `output/<project>/clips/`, and the combined montage is saved alongside the usual download link under `public/exports/`.
- Use the export mode dropdown to render every clip, just missing clips, or a specific numbered range (e.g. `1-4,6`).
- Hit **Update Project** to rescan `output/<project>` and sync the manifest with any clips or images you added by hand.
- Open **Browse Projects** to load previous runs, review which clips exist, or regenerate just the slide you changed.
- Use **Save as Default** in the toolbar to persist the current duration/zoom/fade settings for the next session.

## Export Notes
- Project artifacts live under `output/`; commit-safe placeholders keep the directory in Git while ignoring rendered media.
- Temporary working data still lands in `temp/` and is cleared between renders.
- Set `USE_NVENC=false` if your system lacks NVENC; the server automatically falls back to `libx264` when GPU encoding is unavailable.

## Documentation
See `KEN_BURNS_STUDIO_NOTES.md` for deeper architectural notes, workflow tips, and troubleshooting guidance.
