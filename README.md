# Moving Slide Maker

Moving Slide Maker is a Ken Burns style slideshow tool that lets you define per-image motion paths and export them as an MP4 montage.

## Features
- Web UI for selecting source images and configuring zoom duration, easing, fade, and focus targets.
- Live preview that mirrors final output by using the same transform math and easing curves as the renderer.
- Backend pipeline that renders oversampled frames with Sharp and assembles clips with FFmpeg (NVENC support included).
- One-click export for the full video or a single representative frame, plus JSON plan download for handoff/debugging.

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
4. Visit `http://127.0.0.1:3000` and start defining motion paths.

## Export Notes
- MP4 exports are written to `public/exports/`.
- Temporary frames/clips live under `temp/` and are cleared automatically per export.
- Set `USE_NVENC=false` if your system lacks NVENC; the server falls back to `libx264` automatically when needed.

## Documentation
See `KEN_BURNS_STUDIO_NOTES.md` for deeper architectural notes, workflow tips, and troubleshooting guidance.

