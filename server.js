/**
 * Ken Burns Studio backend
 *
 * Express server that serves the SPA, prepares frame sequences with sharp,
 * and stitches Ken Burns style videos together with FFmpeg.
 */

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs").promises;
const ffmpeg = require("fluent-ffmpeg");
const sharp = require("sharp");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const LOOPBACK_HOST = "127.0.0.1";

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const IMAGES_DIR = path.join(ROOT_DIR, "images");
const EXPORTS_DIR = path.join(ROOT_DIR, "public", "exports");

// --- Config ---
// Location of the FFmpeg binary used for every encoding step.
const FFMPEG_PATH = "C:\\ffmpeg\\bin\\ffmpeg.exe";
ffmpeg.setFfmpegPath(FFMPEG_PATH);

// --- Middleware ---
// Accept large payloads from the frontend when plans include many images.
app.use(express.json({ limit: "50mb" }));
// Serve the compiled frontend assets.
app.use(express.static(PUBLIC_DIR));

// --- API Routes ---

// GET /api/images - List all images in the images directory
// Expose a manifest of images on disk for the frontend gallery.
app.get("/api/images", async (req, res) => {
  try {
    const files = await fs.readdir(IMAGES_DIR);
    const imageEntries = [];
    for (const fileName of files) {
      const ext = path.extname(fileName).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
        continue;
      }

      const absolutePath = path.join(IMAGES_DIR, fileName);
      const stats = await fs.stat(absolutePath);
      if (stats.isFile()) {
        const encodedFile = encodeURIComponent(fileName);
        imageEntries.push({
          id: path.parse(fileName).name,
          fileName,
          url: `/images/${encodedFile}`,
          thumbnailUrl: `/images/${encodedFile}`,
          size: stats.size,
        });
      }
    }
    res.json(imageEntries);
  } catch (err) {
    console.error("Error listing images:", err);
    res.status(500).json({ error: "Unable to read images" });
  }
});

// Working directories that hold intermediate frames and clips.
const TEMP_DIR = path.join(ROOT_DIR, "temp");
const FRAMES_DIR = path.join(TEMP_DIR, "frames");
const CLIPS_DIR = path.join(TEMP_DIR, "clips");

// --- Config ---
// Video characteristics shared by every rendered clip.
const FPS = 30;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const DEFAULT_DURATION = 6;
const DEFAULT_ZOOM = 1.8;

// Render images at a higher resolution before scaling to smooth zooms.
const RENDER_OVERSAMPLE = Math.max(1, Number(process.env.RENDER_OVERSAMPLE) || 2);

// GPU codec preferences with CPU fallbacks for machines without NVENC.
const NVENC_CODEC = process.env.NVENC_CODEC || "h264_nvenc";
const CPU_FALLBACK_CODEC = "libx264";
const USE_NVENC = process.env.USE_NVENC !== "false";

// Build codec-specific flags for FFmpeg runs.
function getCodecOptions(codec) {
  if (codec === NVENC_CODEC) {
    return [
      "-preset", process.env.NVENC_PRESET || "p5",
      "-rc:v", process.env.NVENC_RATE_CONTROL || "vbr",
      "-cq", process.env.NVENC_CQ || "19"
    ];
  }
  return [
    "-preset", process.env.X264_PRESET || "veryfast",
    "-crf", process.env.X264_CRF || "18"
  ];
}

// Detect whether FFmpeg failed because the requested encoder is missing.
function isCodecUnavailableError(error) {

  if (!error) {

    return false;

  }

  const message = [error.message, error.stderr, error.stdout]

    .filter(Boolean)

    .join(' | ')

    .toLowerCase();

  if (!message) {

    return false;

  }

  return message.includes('unknown encoder') ||

    message.includes('no nvenc capable devices') ||

    message.includes('cannot find nvenc') ||

    message.includes('nvenc') && message.includes('not available');

}



// --- Helper Functions (copied from frontend) ---
// Shared math helpers mirrored from the client.
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Sanitize duration values coming from the client payload.
function getSafeDuration(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_DURATION;
}

// Sanitize zoom values coming from the client payload.
function getSafeZoom(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_ZOOM;
}

// --- Easing Functions ---
// Numerical cubic-bezier solver so exports use the same easing as previews.
function cubicBezier(p1x, p1y, p2x, p2y) {
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;

  function sampleCurveX(t) {
    return ((ax * t + bx) * t + cx) * t;
  }

  function sampleCurveY(t) {
    return ((ay * t + by) * t + cy) * t;
  }

  function sampleCurveDerivativeX(t) {
    return (3 * ax * t + 2 * bx) * t + cx;
  }

  function solveCurveX(x, epsilon) {
    let t0 = x;
    for (let i = 0; i < 8; i++) {
      const x2 = sampleCurveX(t0) - x;
      if (Math.abs(x2) < epsilon) {
        return t0;
      }
      const d2 = sampleCurveDerivativeX(t0);
      if (Math.abs(d2) < 1e-6) {
        break;
      }
      t0 = t0 - x2 / d2;
    }
    return t0;
  }

  return function(x) {
    return sampleCurveY(solveCurveX(x, 1e-6));
  };
}

const easeInOut = cubicBezier(0.42, 0, 0.58, 1);

// Reproduce the frontend transform math so exports align with previews.
function getKenBurnsTransform(targetPoint, metrics, scale) {
  if (!targetPoint || !metrics || !metrics.stageWidth || !metrics.stageHeight) {
    return {
      transform: "scale(1)",
      transformOrigin: "50% 50%",
      translateX: 0,
      translateY: 0,
      originX: metrics ? metrics.stageWidth / 2 : 0,
      originY: metrics ? metrics.stageHeight / 2 : 0
    };
  }

  const targetXOnImage = (targetPoint.x / 100) * metrics.displayWidth;
  const targetYOnImage = (targetPoint.y / 100) * metrics.displayHeight;
  const originX = metrics.offsetX + targetXOnImage;
  const originY = metrics.offsetY + targetYOnImage;
  const transformOrigin = `${originX}px ${originY}px`;

  if (scale === 1) {
    return {
      transform: "scale(1) translate(0px, 0px)",
      transformOrigin,
      translateX: 0,
      translateY: 0,
      originX,
      originY
    };
  }

  const viewportCenterX = metrics.stageWidth / 2;
  const viewportCenterY = metrics.stageHeight / 2;
  let translateX = viewportCenterX - originX;
  let translateY = viewportCenterY - originY;

  const scaledTopLeftX = originX + (metrics.offsetX - originX) * scale + translateX;
  const scaledTopLeftY = originY + (metrics.offsetY - originY) * scale + translateY;
  const scaledWidth = metrics.displayWidth * scale;
  const scaledHeight = metrics.displayHeight * scale;
  const scaledBottomRightX = scaledTopLeftX + scaledWidth;
  const scaledBottomRightY = scaledTopLeftY + scaledHeight;

  if (scaledTopLeftX > 0) translateX -= scaledTopLeftX;
  if (scaledBottomRightX < metrics.stageWidth) translateX += metrics.stageWidth - scaledBottomRightX;
  if (scaledTopLeftY > 0) translateY -= scaledTopLeftY;
  if (scaledBottomRightY < metrics.stageHeight) translateY += metrics.stageHeight - scaledBottomRightY;

  const transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  return { transform, transformOrigin, translateX, translateY, originX, originY };
}

// Describe how the source image maps into the viewport dimensions.
function buildBaseMetrics(naturalWidth, naturalHeight) {
  const stageWidth = VIEWPORT_WIDTH;
  const stageHeight = VIEWPORT_HEIGHT;
  const baseScale = Math.min(stageWidth / naturalWidth, stageHeight / naturalHeight);
  const displayWidth = naturalWidth * baseScale;
  const displayHeight = naturalHeight * baseScale;
  const offsetX = (stageWidth - displayWidth) / 2;
  const offsetY = (stageHeight - displayHeight) / 2;
  return {
    stageWidth,
    stageHeight,
    displayWidth,
    displayHeight,
    offsetX,
    offsetY,
    naturalWidth,
    naturalHeight,
    baseScale,
  };
}

// Default or clamp target points into the valid 0-100 range.
function normalizeTargetPoint(targetPoint) {
  if (!targetPoint || typeof targetPoint.x !== 'number' || typeof targetPoint.y !== 'number') {
    return { x: 50, y: 50 };
  }
  return {
    x: clamp(targetPoint.x, 0, 100),
    y: clamp(targetPoint.y, 0, 100),
  };
}

// Convert transform math into a crop rectangle within the oversampled source.
function computeCropRect(transform, metrics, scale) {
  const { translateX, translateY, originX, originY } = transform;
  const stageWidth = metrics.stageWidth;
  const stageHeight = metrics.stageHeight;
  const baseScale = metrics.baseScale;

  const preTransformX = (-translateX - (1 - scale) * originX) / scale;
  const preTransformY = (-translateY - (1 - scale) * originY) / scale;

  const cropWidthStageSpace = stageWidth / scale;
  const cropHeightStageSpace = stageHeight / scale;

  let cropLeft = (preTransformX - metrics.offsetX) / baseScale;
  let cropTop = (preTransformY - metrics.offsetY) / baseScale;
  let cropWidth = cropWidthStageSpace / baseScale;
  let cropHeight = cropHeightStageSpace / baseScale;

  const maxLeft = Math.max(0, metrics.naturalWidth - cropWidth);
  const maxTop = Math.max(0, metrics.naturalHeight - cropHeight);
  cropLeft = clamp(cropLeft, 0, maxLeft);
  cropTop = clamp(cropTop, 0, maxTop);

  return { left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight };
}


// --- Frame Generation ---
// Render per-frame crops for a single image at the requested motion path.
async function generateFramesForImage(imageConfig, imageIndex, options = {}) {
  console.log(` -> Preparing frames for image ${imageIndex}`);
  const imagePath = path.join(IMAGES_DIR, imageConfig.fileName);

  let imageBuffer;
  try {
    imageBuffer = await fs.readFile(imagePath);
  } catch (err) {
    throw new Error(`Failed to read image file: ${imageConfig.fileName}`);
  }

  const sourceSharp = sharp(imageBuffer, { failOn: 'none' });
  const sourceMetadata = await sourceSharp.metadata();
  if (!sourceMetadata.width || !sourceMetadata.height) {
    throw new Error(`Unable to read dimensions for ${imageConfig.fileName}`);
  }

  const oversample = RENDER_OVERSAMPLE;
  const workingWidth = Math.max(1, Math.round(sourceMetadata.width * oversample));
  const workingHeight = Math.max(1, Math.round(sourceMetadata.height * oversample));

  const workingBuffer = oversample === 1
    ? imageBuffer
    : await sourceSharp
        .clone()
        .resize(workingWidth, workingHeight, {
          fit: 'fill',
          kernel: sharp.kernel.lanczos3
        })
        .toBuffer();

  const workingSharp = sharp(workingBuffer, { failOn: 'none' });
  const metrics = buildBaseMetrics(workingWidth, workingHeight);

  const duration = getSafeDuration(imageConfig?.config?.duration);
  const targetZoom = getSafeZoom(imageConfig?.config?.zoom);
  const targetPoint = normalizeTargetPoint(imageConfig?.config?.targetPoint);
  const motionStyle = imageConfig?.config?.motionStyle || 'ping-pong';

  const singleProgressRaw = typeof options.singleProgress === 'number'
    ? clamp(options.singleProgress, 0, 1)
    : null;
  const customOutputPath = typeof options.outputPath === 'string' ? options.outputPath : null;

  const totalFrames = Math.max(2, Math.ceil(duration * FPS));

  const startZoom = motionStyle === 'zoom-out' ? targetZoom : 1;
  const endZoom = motionStyle === 'zoom-out' ? 1 : targetZoom;
  const startTransform = getKenBurnsTransform(targetPoint, metrics, startZoom);
  const endTransform = getKenBurnsTransform(targetPoint, metrics, endZoom);
  const startRect = computeCropRect(startTransform, metrics, startZoom);
  const endRect = computeCropRect(endTransform, metrics, endZoom);

  const interpolateRect = (a, b, t) => ({
    left: a.left + (b.left - a.left) * t,
    top: a.top + (b.top - a.top) * t,
    width: a.width + (b.width - a.width) * t,
    height: a.height + (b.height - a.height) * t,
  });

  const frameJobs = [];
  if (singleProgressRaw !== null) {
    frameJobs.push({
      normalized: singleProgressRaw,
      outputPath: customOutputPath || path.join(FRAMES_DIR, `img-${imageIndex}-frame-single.png`),
    });
  } else {
    for (let frame = 0; frame < totalFrames; frame++) {
      const normalized = totalFrames > 1 ? frame / (totalFrames - 1) : 0;
      frameJobs.push({
        normalized,
        outputPath: path.join(
          FRAMES_DIR,
          `img-${imageIndex}-frame-${String(frame).padStart(4, '0')}.png`
        ),
      });
    }
  }

  console.log(` -> Generating ${frameJobs.length} frame${frameJobs.length === 1 ? '' : 's'} via sharp...`);

  const renderedPaths = [];

  for (const { normalized, outputPath } of frameJobs) {
    let easedProgress;
    let zoomStart = startZoom;
    let zoomEnd = endZoom;
    let rectStart = startRect;
    let rectEnd = endRect;

    if (motionStyle === 'ping-pong') {
      const forward = normalized <= 0.5;
      const segmentProgress = forward ? normalized / 0.5 : (1 - normalized) / 0.5;
      easedProgress = easeInOut(segmentProgress);
      if (!forward) {
        zoomStart = endZoom;
        zoomEnd = startZoom;
        rectStart = endRect;
        rectEnd = startRect;
      }
    } else {
      easedProgress = easeInOut(normalized);
    }

    const currentZoom = zoomStart + (zoomEnd - zoomStart) * easedProgress;
    const cropRect = interpolateRect(rectStart, rectEnd, easedProgress);

    let left = Math.floor(cropRect.left);
    let top = Math.floor(cropRect.top);
    let right = Math.ceil(cropRect.left + cropRect.width);
    let bottom = Math.ceil(cropRect.top + cropRect.height);

    left = clamp(left, 0, Math.max(0, workingWidth - 1));
    top = clamp(top, 0, Math.max(0, workingHeight - 1));
    right = clamp(right, left + 1, workingWidth);
    bottom = clamp(bottom, top + 1, workingHeight);

    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);

    await workingSharp
      .clone()
      .extract({ left, top, width, height })
      .resize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, {
        fit: 'fill',
        kernel: sharp.kernel.lanczos3
      })
      .toFile(outputPath);

    renderedPaths.push(outputPath);
  }

  console.log(` -> Frame generation complete for image ${imageIndex}`);
  return renderedPaths;
}

// --- Video Clip Generation ---
// Feed the generated PNG frames into FFmpeg to create an individual clip.
function createClipFromFrames(imageIndex, duration) {
  const safeDuration = getSafeDuration(duration);
  const inputPattern = path.join(FRAMES_DIR, `img-${imageIndex}-frame-%04d.png`);
  const outputPath = path.join(CLIPS_DIR, `clip-${imageIndex}.mp4`);

  async function encodeWithCodec(codec) {
    return new Promise((resolve, reject) => {
      console.log(` -> Encoding clip for image ${imageIndex} (${safeDuration}s) using ${codec}`);
      const command = ffmpeg()
        .input(inputPattern)
        .inputOptions([`-framerate ${FPS}`])
        .videoCodec(codec)
        .outputOptions([
          "-pix_fmt", "yuv420p",
          "-r", String(FPS),
          "-t", String(safeDuration),
          ...getCodecOptions(codec)
        ])
        .output(outputPath)
        .on("end", () => {
          console.log(` -> Finished encoding clip ${imageIndex} using ${codec}`);
          resolve(outputPath);
        })
        .on("error", (err) => {
          reject(err);
        });
      command.run();
    });
  }

  const preferredCodec = USE_NVENC ? NVENC_CODEC : CPU_FALLBACK_CODEC;
  return encodeWithCodec(preferredCodec).catch(async (err) => {
    if (USE_NVENC && isCodecUnavailableError(err)) {
      console.warn(" -> NVENC unavailable, falling back to libx264");
      return encodeWithCodec(CPU_FALLBACK_CODEC);
    }
    console.error(` -> Error encoding clip ${imageIndex}:`, err);
    throw err;
  });
}

// --- Final Video Combination ---
// Chain every clip together, applying fades between neighbors when requested.
function combineClips(clipPaths, plan) {
  const finalOutputName = `ken-burns-effect-${Date.now()}.mp4`;
  const finalOutputPath = path.join(EXPORTS_DIR, finalOutputName);

  if (!clipPaths || clipPaths.length === 0) {
    return Promise.reject(new Error("No clips were generated to combine."));
  }

  if (clipPaths.length === 1) {
    return fs.copyFile(clipPaths[0], finalOutputPath).then(() => finalOutputName);
  }

  const preferredCodec = USE_NVENC ? NVENC_CODEC : CPU_FALLBACK_CODEC;

  const buildCommand = (codec) => {
    const command = ffmpeg();
    clipPaths.forEach((inputPath) => command.input(inputPath));

    let filterChain = "";
    let runningOutputDuration = plan.length > 0 ? getSafeDuration(plan[0]?.config?.duration) : 0;
    let lastStream = "[0:v]";

    for (let i = 0; i < clipPaths.length - 1; i++) {
      const currentClipDuration = getSafeDuration(plan[i]?.config?.duration);
      const nextClipDuration = getSafeDuration(plan[i + 1]?.config?.duration);
      const rawFade = Number(plan[i]?.config?.fadeDuration);
      const fadeDuration = clamp(
        Number.isFinite(rawFade) && rawFade >= 0 ? rawFade : 0.5,
        0,
        Math.max(0, Math.min(currentClipDuration, nextClipDuration) - 0.01)
      );

      const offset = Math.max(0, runningOutputDuration - fadeDuration);
      const nextStream = `[${i + 1}:v]`;
      const outStream = `[v${i + 1}]`;

      filterChain += `${lastStream}${nextStream}xfade=transition=fade:duration=${fadeDuration}:offset=${offset}${outStream};`;
      lastStream = outStream;
      runningOutputDuration += nextClipDuration - fadeDuration;
    }

    const trimmedFilterChain = filterChain.endsWith(';') ? filterChain.slice(0, -1) : filterChain;
    const hasFilter = Boolean(trimmedFilterChain && trimmedFilterChain.length);
    const finalMap = hasFilter ? lastStream : '0:v';
    if (hasFilter) {
      command.complexFilter(trimmedFilterChain);
    }
    command.videoCodec(codec);
    command.outputOptions([
      "-map", finalMap,
      "-pix_fmt", "yuv420p",
      "-r", String(FPS),
      ...getCodecOptions(codec)
    ]);
    command.output(finalOutputPath);
    return command;
  };

  const encodeWithCodec = (codec) => new Promise((resolve, reject) => {
    console.log(`Combining ${clipPaths.length} clips into final video with ${codec}...`);
    const command = buildCommand(codec);
    command
      .on("end", () => {
        console.log(`Finished combining clips with ${codec}.`);
        resolve(finalOutputName);
      })
      .on("error", reject)
      .run();
  });

  return encodeWithCodec(preferredCodec).catch((err) => {
    if (USE_NVENC && isCodecUnavailableError(err)) {
      console.warn("NVENC unavailable during combine, falling back to libx264.");
      return encodeWithCodec(CPU_FALLBACK_CODEC);
    }
    console.error("Error combining clips:", err);
    throw err;
  });
}


// --- API Routes ---

// GET /api/images - List all images in the images directory
app.get("/api/images", async (req, res) => {
  try {
    const files = await fs.readdir(IMAGES_DIR);
    const imageEntries = [];
    for (const fileName of files) {
      const ext = path.extname(fileName).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
        continue;
      }

      const absolutePath = path.join(IMAGES_DIR, fileName);
      const stats = await fs.stat(absolutePath);
      if (stats.isFile()) {
        const encodedFile = encodeURIComponent(fileName);
        imageEntries.push({
          id: path.parse(fileName).name,
          fileName,
          url: `/images/${encodedFile}`,
          thumbnailUrl: `/images/${encodedFile}`,
          size: stats.size,
        });
      }
    }
    res.json(imageEntries);
  } catch (err) {
    console.error("Error listing images:", err);
    res.status(500).json({ error: "Unable to read images" });
  }
});

// POST /api/export-video - Main video export logic
// Main export endpoint that renders frames, encodes clips, then stitches them.
app.post("/api/export-video", async (req, res) => {
  console.log("Received video export request...");
  const plan = req.body.plan;

  if (!plan || !Array.isArray(plan) || plan.length === 0) {
    return res.status(400).json({ error: "Invalid export plan provided." });
  }

  try {
    console.log("Setting up temporary directories...");
    await fs.rm(TEMP_DIR, { recursive: true, force: true });
    await fs.mkdir(FRAMES_DIR, { recursive: true });
    await fs.mkdir(CLIPS_DIR, { recursive: true });

    const clipPaths = [];
    for (let i = 0; i < plan.length; i++) {
      const imageConfig = plan[i];
      console.log(`Processing image ${i + 1}/${plan.length}: ${imageConfig.fileName}`);
      await generateFramesForImage(imageConfig, i);
      const clipPath = await createClipFromFrames(i, imageConfig.config.duration);
      clipPaths.push(clipPath);
    }

    console.log("All clips generated. Combining into final video...");
    const finalVideoName = await combineClips(clipPaths, plan);

    console.log("Cleaning up temporary files...");
    await fs.rm(TEMP_DIR, { recursive: true, force: true });

    console.log(`Export complete: ${finalVideoName}`);
    res.status(200).json({
      success: true,
      message: "Export complete!",
      downloadUrl: `/exports/${finalVideoName}`
    });

  } catch (error) {
    console.error("Video export failed:", error);
    res.status(500).json({ success: false, message: `Export failed: ${error.message}` });
  }
});




// POST /api/export-frame - Render a single frame for quick preview
// Lightweight endpoint that renders a single frame for quick previews.
app.post("/api/export-frame", async (req, res) => {
  const plan = req.body.plan;
  const targetId = req.body.singleFrame;

  if (!plan || !Array.isArray(plan) || plan.length === 0) {
    return res.status(400).json({ error: "Invalid export plan provided." });
  }
  if (!targetId) {
    return res.status(400).json({ error: "No target image specified for frame export." });
  }

  const imageIndex = plan.findIndex((item) => item.id === targetId);
  if (imageIndex === -1) {
    return res.status(404).json({ error: "Requested image not found in the plan." });
  }

  const imageConfig = plan[imageIndex];
  try {
    const safeId = (imageConfig.id || path.parse(imageConfig.fileName || `image-${imageIndex}`).name)
      .toString()
      .replace(/[^a-z0-9_-]/gi, "_")
      .toLowerCase();
    const outputName = `frame-${safeId}-${Date.now()}.png`;
    const outputPath = path.join(EXPORTS_DIR, outputName);

    const motionStyle = imageConfig?.config?.motionStyle || 'ping-pong';
    let singleProgress = 1;
    if (motionStyle === 'ping-pong') {
      singleProgress = 0.5;
    } else if (motionStyle === 'zoom-out') {
      singleProgress = 0;
    }

    await generateFramesForImage(imageConfig, imageIndex, {
      singleProgress,
      outputPath,
    });

    res.status(200).json({
      success: true,
      message: 'Frame exported.',
      downloadUrl: `/exports/${outputName}`,
    });
  } catch (error) {
    console.error('Single frame export failed:', error);
    res.status(500).json({ success: false, message: `Frame export failed: ${error.message}` });
  }
});

// --- Static file serving for images ---
// Allow direct access to original source images.
app.use("/images", express.static(IMAGES_DIR));

// --- Fallback to index.html for client-side routing ---
// Let the React router handle every other request.
app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// --- Server Start ---
// Ensure directories exist and start listening for requests.
async function startServer() {
  try {
    await fs.mkdir(EXPORTS_DIR, { recursive: true });
    console.log(`Exports directory ensured at: ${EXPORTS_DIR}`);

    const server = http.createServer(app);
    server.listen(PORT, HOST, () => {
      console.log(`Ken Burns Studio running at http://${LOOPBACK_HOST}:${PORT} (listening on ${HOST})`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

startServer();
