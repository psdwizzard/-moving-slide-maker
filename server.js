/**
 * Ken Burns Studio backend
 *
 * Express server that serves the SPA, prepares frame sequences with sharp,
 * and stitches Ken Burns style videos together with FFmpeg.
 */

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const ffmpeg = require("fluent-ffmpeg");
const sharp = require("sharp");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const LOOPBACK_HOST = "127.0.0.1";

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const IMAGES_DIR = path.join(ROOT_DIR, "images");
const EXPORTS_DIR = path.join(PUBLIC_DIR, "exports");
const OUTPUT_DIR = path.join(ROOT_DIR, "output");
const SETTINGS_PATH = path.join(OUTPUT_DIR, "settings.json");

// --- Config ---
// Location of the FFmpeg binary used for every encoding step.
const FFMPEG_PATH = "C:\\ffmpeg\\bin\\ffmpeg.exe";
ffmpeg.setFfmpegPath(FFMPEG_PATH);

// --- Helpers ---
function fileExistsSync(targetPath) {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch (err) {
    return false;
  }
}

async function ensureDirectory(targetPath) {
  await fsp.mkdir(targetPath, { recursive: true });
}


async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch (err) {
    return false;
  }
}

function toPosixPath(value) {
  if (!value) {
    return value;
  }
  return value.split(path.sep).join('/');
}

function buildProjectAssetUrl(slug, relativePath) {
  const normalized = toPosixPath(relativePath || '');
  const segments = normalized.split('/').filter(Boolean);
  const encoded = [slug, ...segments].map((segment) => encodeURIComponent(segment));
  return `/projects/${encoded.join('/')}`;
}

async function findFirstExisting(paths) {
  for (const candidate of paths) {
    if (!candidate) {
      continue;
    }
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function cleanupFramesForIndex(imageIndex) {
  const prefix = `img-${imageIndex}-frame-`;
  try {
    const entries = await fsp.readdir(FRAMES_DIR);
    const targets = entries.filter((name) => name.startsWith(prefix));
    if (!targets.length) {
      return;
    }
    await Promise.all(
      targets.map((name) =>
        fsp.unlink(path.join(FRAMES_DIR, name)).catch((err) => {
          if (err?.code !== 'ENOENT') {
            console.warn(`Failed to remove frame ${name}:`, err.message);
          }
        })
      )
    );
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn(`Failed to list frames for index ${imageIndex}:`, err.message);
    }
  }
}

function parseRenderRange(rangeText, total) {
  if (!rangeText) {
    return new Set();
  }
  const tokens = String(rangeText)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const values = new Set();
  for (const token of tokens) {
    if (token.includes('-')) {
      const [startRaw, endRaw] = token.split('-').map((part) => part.trim());
      const start = Number.parseInt(startRaw, 10);
      const end = Number.parseInt(endRaw, 10);
      if (Number.isInteger(start) && Number.isInteger(end)) {
        const lower = Math.min(start, end);
        const upper = Math.max(start, end);
        for (let value = lower; value <= upper; value++) {
          values.add(value);
        }
      }
    } else {
      const single = Number.parseInt(token, 10);
      if (Number.isInteger(single)) {
        values.add(single);
      }
    }
  }
  const bounded = new Set();
  for (const value of values) {
    const index = value - 1;
    if (index >= 0 && index < total) {
      bounded.add(index);
    }
  }
  return bounded;
}

async function prepareProjectImage(entry, slug, projectDir) {
  const projectImagesDir = path.join(projectDir, 'images');
  await ensureDirectory(projectImagesDir);

  const fallbackRelative = path.posix.join('images', entry.fileName);
  const relativePathRaw = entry.imagePath ? toPosixPath(entry.imagePath) : fallbackRelative;
  const relativePath = relativePathRaw || fallbackRelative;
  const absolutePath = path.join(projectDir, ...relativePath.split('/'));

  if (!(await pathExists(absolutePath))) {
    const manifestCandidate = entry.imagePath
      ? path.join(projectDir, ...toPosixPath(entry.imagePath).split('/'))
      : null;
    const existingSource = await findFirstExisting([
      entry.absolutePath,
      manifestCandidate,
      path.join(IMAGES_DIR, entry.fileName)
    ]);
    const sourcePath = existingSource || path.join(IMAGES_DIR, entry.fileName);
    if (!(await pathExists(sourcePath))) {
      throw new Error(`Source image not found for ${entry.fileName}`);
    }
    if (path.resolve(sourcePath) !== path.resolve(absolutePath)) {
      await ensureDirectory(path.dirname(absolutePath));
      await fsp.rename(sourcePath, absolutePath);
    }
  }

  const stats = await fsp.stat(absolutePath);
  const relativeToProject = toPosixPath(path.relative(projectDir, absolutePath));

  return {
    ...entry,
    imagePath: relativeToProject,
    absolutePath,
    imageUrl: buildProjectAssetUrl(slug, relativeToProject),
    size: stats.size
  };
}

async function resolveImageAbsolutePath(entry, slug) {
  if (entry?.absolutePath && await pathExists(entry.absolutePath)) {
    return entry.absolutePath;
  }
  if (slug) {
    const projectDir = path.join(OUTPUT_DIR, slug);
    if (entry?.imagePath) {
      const manifestPath = path.join(projectDir, ...toPosixPath(entry.imagePath).split('/'));
      if (await pathExists(manifestPath)) {
        return manifestPath;
      }
    }
    const projectDefault = path.join(projectDir, 'images', entry.fileName);
    if (await pathExists(projectDefault)) {
      return projectDefault;
    }
  }
  const ingestPath = path.join(IMAGES_DIR, entry.fileName);
  if (await pathExists(ingestPath)) {
    return ingestPath;
  }
  throw new Error(`Source image not found for ${entry.fileName}`);
}

function toManifestImageRecord(entry) {
  const relativePath = entry.imagePath ? toPosixPath(entry.imagePath) : path.posix.join('images', entry.fileName);
  return {
    id: entry.id,
    fileName: entry.fileName,
    imagePath: relativePath,
    imageUrl: entry.imageUrl || null,
    size: entry.size,
    config: entry.config,
    clipFile: entry.clipFile ? toPosixPath(entry.clipFile) : null
  };
}

function hydrateManifest(manifest, slug) {
  if (!manifest) {
    return null;
  }
  const safeSlug = manifest.slug || slug;
  const images = Array.isArray(manifest.images)
    ? manifest.images.map((image) => {
        const relativePath = image.imagePath ? toPosixPath(image.imagePath) : path.posix.join('images', image.fileName);
        const clipFile = image.clipFile ? toPosixPath(image.clipFile) : null;
        return {
          ...image,
          imagePath: relativePath,
          imageUrl: image.imageUrl || (safeSlug ? buildProjectAssetUrl(safeSlug, relativePath) : null),
          clipFile,
        };
      })
    : [];
  const finalVideo = manifest.finalVideo
    ? {
        ...manifest.finalVideo,
        path: manifest.finalVideo?.path ? toPosixPath(manifest.finalVideo.path) : manifest.finalVideo.path
      }
    : null;
  return {
    ...manifest,
    slug: safeSlug,
    images,
    finalVideo
  };
}
function sanitizeProjectName(rawName) {
  const trimmed = (rawName || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "-")
    .toLowerCase();
}

async function readJSON(filePath, fallback) {
  try {
    const data = await fsp.readFile(filePath, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    return fallback;
  }
}

async function writeJSON(filePath, value) {
  await ensureDirectory(path.dirname(filePath));
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function loadSettings() {
  const raw = await readJSON(SETTINGS_PATH, {});
  const defaults = {
    defaultConfig: { ...BASE_DEFAULT_CONFIG },
    autoMotion: { ...SETTINGS_DEFAULTS.autoMotion }
  };
  return {
    ...defaults,
    ...raw,
    defaultConfig: { ...BASE_DEFAULT_CONFIG, ...(raw?.defaultConfig || {}) },
    autoMotion: { ...SETTINGS_DEFAULTS.autoMotion, ...(raw?.autoMotion || {}) }
  };
}

async function saveSettings(settings) {
  const payload = {
    defaultConfig: settings.defaultConfig,
    autoMotion: settings.autoMotion
  };
  await writeJSON(SETTINGS_PATH, payload);
}

function resolveConfigWithDefaults(config, defaultConfig) {
  return {
    duration: getSafeDuration(config?.duration ?? defaultConfig.duration),
    zoom: getSafeZoom(config?.zoom ?? defaultConfig.zoom),
    fadeDuration: Number.isFinite(config?.fadeDuration) ? Math.max(0, config.fadeDuration) : defaultConfig.fadeDuration,
    motionStyle: config?.motionStyle || defaultConfig.motionStyle || "ping-pong",
    lockZoom: Boolean(config?.lockZoom ?? defaultConfig.lockZoom),
    targetPoint: config?.targetPoint || null,
    arrow: config?.arrow || null,
    preset: config?.preset || defaultConfig.preset || "custom"
  };
}

async function loadManifest(projectDir) {
  const manifestPath = path.join(projectDir, "manifest.json");
  return readJSON(manifestPath, null);
}

async function saveManifest(projectDir, manifest) {
  const manifestPath = path.join(projectDir, "manifest.json");
  await writeJSON(manifestPath, manifest);
}

async function listProjects() {
  if (!fileExistsSync(OUTPUT_DIR)) {
    return [];
  }
  const entries = await fsp.readdir(OUTPUT_DIR, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const projectDir = path.join(OUTPUT_DIR, entry.name);
    const manifest = await loadManifest(projectDir);
    if (!manifest) {
      continue;
    }
    const normalizedManifest = hydrateManifest(manifest, entry.name);
    projects.push({
      name: normalizedManifest?.name,
      slug: normalizedManifest?.slug || entry.name,
      createdAt: normalizedManifest?.createdAt,
      updatedAt: normalizedManifest?.updatedAt,
      clipCount: normalizedManifest?.images?.length || 0,
      finalVideo: normalizedManifest?.finalVideo || null
    });
  }
  projects.sort((a, b) => {
    const left = a.updatedAt || a.createdAt || "";
    const right = b.updatedAt || b.createdAt || "";
    return (right || "").localeCompare(left || "");
  });
  return projects;
}

async function archiveClipsAndFinal(projectDir, clipTempPaths, finalVideoName, manifestPlan) {
  const clipsDir = path.join(projectDir, "clips");
  await ensureDirectory(clipsDir);

  for (let i = 0; i < clipTempPaths.length; i++) {
    const tempClip = clipTempPaths[i];
    const clipName = `clip-${i}.mp4`;
    const destClipPath = path.join(clipsDir, clipName);

    if (path.resolve(tempClip) !== path.resolve(destClipPath)) {
      await fsp.copyFile(tempClip, destClipPath);
    }

    if (manifestPlan[i]) {
      const relativeClip = toPosixPath(path.relative(projectDir, destClipPath));
      manifestPlan[i].clipFile = relativeClip;
    }
  }

  const finalSource = path.join(EXPORTS_DIR, finalVideoName);
  const finalDest = path.join(projectDir, finalVideoName);
  await fsp.copyFile(finalSource, finalDest);

  return {
    finalPath: finalDest
  };
}

async function resolvePlanWithDefaults(plan, defaultConfig, settings, options = {}) {
  const resolved = [];
  let mutated = false;
  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i];
    const config = resolveConfigWithDefaults(entry.config || {}, defaultConfig);
    if (!config.targetPoint) {
      config.targetPoint = { x: 50, y: 50 };
      const nextMotion = settings.autoMotion?.next === 'zoom-out' ? 'zoom-out' : 'zoom-in';
      config.motionStyle = nextMotion;
      settings.autoMotion = { next: nextMotion === 'zoom-in' ? 'zoom-out' : 'zoom-in' };
      mutated = true;
    }
    resolved.push({
      ...entry,
      config
    });
  }

  if (mutated && !options.skipSave) {
    await saveSettings(settings);
  }

  return resolved;
}

// --- Middleware ---
// Accept large payloads from the frontend when plans include many images.
app.use(express.json({ limit: "50mb" }));
// Serve the compiled frontend assets.
app.use(express.static(PUBLIC_DIR));
app.use('/projects', express.static(OUTPUT_DIR));

// --- API Routes ---

// GET /api/images - List all images in the images directory
// Expose a manifest of images on disk for the frontend gallery.
app.get("/api/images", async (req, res) => {
  try {
    const files = await fsp.readdir(IMAGES_DIR);
    const imageEntries = [];
    for (const fileName of files) {
      const ext = path.extname(fileName).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
        continue;
      }

      const absolutePath = path.join(IMAGES_DIR, fileName);
      const stats = await fsp.stat(absolutePath);
      if (stats.isFile()) {
        const encodedFile = encodeURIComponent(fileName);
        imageEntries.push({
          id: path.parse(fileName).name,
          fileName,
          imagePath: path.posix.join('images', fileName),
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

app.get("/api/projects", async (req, res) => {
  try {
    const projects = await listProjects();
    res.json(projects);
  } catch (error) {
    console.error('Failed to list projects:', error);
    res.status(500).json({ error: 'Unable to list projects' });
  }
});

app.get("/api/projects/:project", async (req, res) => {
  const slug = sanitizeProjectName(req.params.project);
  if (!slug) {
    return res.status(400).json({ error: 'Invalid project name' });
  }

  try {
    const projectDir = path.join(OUTPUT_DIR, slug);
    const manifest = await loadManifest(projectDir);
    if (!manifest) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(hydrateManifest(manifest, slug));
  } catch (error) {
    console.error('Failed to load project manifest:', error);
    res.status(500).json({ error: 'Unable to load project manifest' });
  }
});

app.get("/api/settings", async (req, res) => {
  try {
    const settings = await loadSettings();
    res.json({
      defaultConfig: settings.defaultConfig,
      autoMotionNext: settings.autoMotion?.next || 'zoom-in'
    });
  } catch (error) {
    console.error('Failed to load settings:', error);
    res.status(500).json({ error: 'Unable to load settings' });
  }
});

app.post("/api/settings/default-config", async (req, res) => {
  try {
    const settings = await loadSettings();
    const bodyConfig = req.body?.defaultConfig;
    if (!bodyConfig || typeof bodyConfig !== 'object') {
      return res.status(400).json({ error: 'defaultConfig is required' });
    }
    const merged = resolveConfigWithDefaults(bodyConfig, settings.defaultConfig);
    settings.defaultConfig = {
      duration: merged.duration,
      zoom: merged.zoom,
      fadeDuration: merged.fadeDuration,
      motionStyle: merged.motionStyle,
      lockZoom: merged.lockZoom,
      preset: merged.preset
    };
    await saveSettings(settings);
    res.json({ defaultConfig: settings.defaultConfig });
  } catch (error) {
    console.error('Failed to update default config:', error);
    res.status(500).json({ error: 'Unable to update default config' });
  }
});

app.post("/api/projects/:project/regenerate-clip", async (req, res) => {
  const slug = sanitizeProjectName(req.params.project);
  if (!slug) {
    return res.status(400).json({ error: 'Invalid project name' });
  }

  const projectDir = path.join(OUTPUT_DIR, slug);
  const manifest = await loadManifest(projectDir);
  if (!manifest) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const imageId = req.body?.imageId;
  if (!imageId) {
    return res.status(400).json({ error: 'imageId is required' });
  }

  const imageIndex = manifest.images.findIndex((img) => img.id === imageId);
  if (imageIndex === -1) {
    return res.status(404).json({ error: 'Image not found in project' });
  }

  try {
    await fsp.rm(TEMP_DIR, { recursive: true, force: true });
    await ensureDirectory(FRAMES_DIR);
    await ensureDirectory(CLIPS_DIR);

    const settings = await loadSettings();
    const existing = manifest.images[imageIndex];
    const incoming = req.body?.config && typeof req.body.config === 'object' ? req.body.config : null;
    const mergedConfig = incoming ? { ...existing.config, ...incoming } : existing.config;
    const resolvedConfig = resolveConfigWithDefaults(mergedConfig, settings.defaultConfig);

    if (!resolvedConfig.targetPoint) {
      resolvedConfig.targetPoint = { x: 50, y: 50 };
      const nextMotion = settings.autoMotion?.next === 'zoom-out' ? 'zoom-out' : 'zoom-in';
      resolvedConfig.motionStyle = nextMotion;
      settings.autoMotion = { next: nextMotion === 'zoom-in' ? 'zoom-out' : 'zoom-in' };
      await saveSettings(settings);
    }

    const preparedEntry = await prepareProjectImage({ ...existing, config: resolvedConfig }, slug, projectDir);

    await cleanupFramesForIndex(imageIndex);
    await generateFramesForImage(preparedEntry, imageIndex);
    const clipTempPath = await createClipFromFrames(imageIndex, resolvedConfig.duration);
    await cleanupFramesForIndex(imageIndex);

    const clipPaths = manifest.images.map((img, idx) => {
      if (idx === imageIndex) {
        return clipTempPath;
      }
      const relative = img.clipFile ? toPosixPath(img.clipFile) : path.posix.join('clips', `clip-${idx}.mp4`);
      return path.join(projectDir, ...relative.split('/'));
    });

    const plan = manifest.images.map((img, idx) => ({
      id: img.id,
      fileName: img.fileName,
      config: idx === imageIndex ? preparedEntry.config : img.config
    }));

    manifest.images[imageIndex] = preparedEntry;

    const finalVideoName = await combineClips(clipPaths, plan, { outputNamePrefix: slug });
    const archived = await archiveClipsAndFinal(projectDir, clipPaths, finalVideoName, manifest.images);

    const finalVideoRelative = toPosixPath(path.relative(projectDir, archived.finalPath));
    const updatedImages = manifest.images.map((img) => toManifestImageRecord(img));

    const manifestRecord = {
      ...manifest,
      images: updatedImages,
      finalVideo: {
        fileName: finalVideoName,
        path: finalVideoRelative
      },
      updatedAt: new Date().toISOString()
    };

    await saveManifest(projectDir, manifestRecord);
    await fsp.rm(TEMP_DIR, { recursive: true, force: true });

    const projects = await listProjects();
    const hydratedManifest = hydrateManifest(manifestRecord, slug);

    res.json({ success: true, manifest: hydratedManifest, projects });
  } catch (error) {
    console.error('Failed to regenerate clip:', error);
    res.status(500).json({ error: `Clip regeneration failed: ${error.message}` });
  }
});


app.post("/api/export-video", async (req, res) => {
  console.log("Received video export request...");
  const plan = req.body.plan;
  const projectName = req.body.projectName;
  const renderMode = (typeof req.body.renderMode === 'string' ? req.body.renderMode : 'all').toLowerCase();
  const renderRangeRaw = typeof req.body.renderRange === 'string' ? req.body.renderRange : '';

  if (!projectName || typeof projectName !== 'string') {
    return res.status(400).json({ error: 'projectName is required.' });
  }

  if (!plan || !Array.isArray(plan) || plan.length === 0) {
    return res.status(400).json({ error: "Invalid export plan provided." });
  }

  const slug = sanitizeProjectName(projectName);
  if (!slug) {
    return res.status(400).json({ error: 'Project name cannot be empty.' });
  }

  try {
    const projectDir = path.join(OUTPUT_DIR, slug);
    await ensureDirectory(projectDir);

    console.log("Setting up temporary directories...");
    await fsp.rm(TEMP_DIR, { recursive: true, force: true });
    await ensureDirectory(FRAMES_DIR);
    await ensureDirectory(CLIPS_DIR);

    const projectClipsDir = path.join(projectDir, "clips");
    await ensureDirectory(projectClipsDir);

    const settings = await loadSettings();
    const resolvedPlan = await resolvePlanWithDefaults(plan, settings.defaultConfig, settings);

    const existingManifest = await loadManifest(projectDir);
    const existingImageMap = new Map();
    if (existingManifest?.images) {
      existingManifest.images.forEach((img) => {
        if (img?.id) {
          existingImageMap.set(img.id, img);
        }
      });
    }

    const alwaysMissing = new Set();
    for (let i = 0; i < resolvedPlan.length; i++) {
      const candidate = resolvedPlan[i];
      const manifestEntry = existingImageMap.get(candidate.id);
      const clipRelative = candidate.clipFile || manifestEntry?.clipFile;
      if (!clipRelative) {
        alwaysMissing.add(i);
        continue;
      }
      const absoluteClip = path.join(projectDir, ...toPosixPath(clipRelative).split('/'));
      // eslint-disable-next-line no-await-in-loop
      if (!(await pathExists(absoluteClip))) {
        alwaysMissing.add(i);
      }
    }

    let indicesToRender;
    if (renderMode === 'missing') {
      indicesToRender = new Set(alwaysMissing);
    } else if (renderMode === 'range') {
      const rangeSet = parseRenderRange(renderRangeRaw, resolvedPlan.length);
      indicesToRender = new Set([...rangeSet, ...alwaysMissing]);
      if (!indicesToRender.size) {
        return res.status(400).json({ error: 'No matching clips found for the requested range.' });
      }
    } else {
      indicesToRender = new Set(Array.from({ length: resolvedPlan.length }, (_, idx) => idx));
    }

    const clipPaths = [];

    for (let i = 0; i < resolvedPlan.length; i++) {
      const preparedImage = await prepareProjectImage(resolvedPlan[i], slug, projectDir);
      resolvedPlan[i] = preparedImage;

      const manifestEntry = existingImageMap.get(preparedImage.id);
      let clipRelative = preparedImage.clipFile || manifestEntry?.clipFile || path.posix.join('clips', `clip-${i}.mp4`);
      clipRelative = toPosixPath(clipRelative);
      let existingClipAbsolute = path.join(projectDir, ...clipRelative.split('/'));

      let shouldRender = indicesToRender.has(i);
      if (!shouldRender && !(await pathExists(existingClipAbsolute))) {
        shouldRender = true;
      }

      if (shouldRender) {
        await cleanupFramesForIndex(i);
        console.log(`Processing image ${i + 1}/${resolvedPlan.length}: ${preparedImage.fileName}`);
        await generateFramesForImage(preparedImage, i);
        const tempClipPath = await createClipFromFrames(i, preparedImage.config.duration);
        clipPaths.push(tempClipPath);
        preparedImage.clipFile = path.posix.join('clips', `clip-${i}.mp4`);
        await cleanupFramesForIndex(i);
      } else {
        console.log(`Reusing existing clip for image ${i + 1}`);
        clipPaths.push(existingClipAbsolute);
        preparedImage.clipFile = toPosixPath(path.relative(projectDir, existingClipAbsolute));
      }
    }

    console.log("All clips ready. Combining into final video...");
    const finalVideoName = await combineClips(clipPaths, resolvedPlan, { outputNamePrefix: slug });

    console.log("Archiving clips and final output...");
    const archived = await archiveClipsAndFinal(projectDir, clipPaths, finalVideoName, resolvedPlan);

    const now = new Date().toISOString();
    const finalVideoRelative = toPosixPath(path.relative(projectDir, archived.finalPath));

    const manifestRecord = {
      name: projectName,
      slug,
      createdAt: existingManifest?.createdAt || now,
      updatedAt: now,
      images: resolvedPlan.map((item) => toManifestImageRecord(item)),
      finalVideo: {
        fileName: finalVideoName,
        path: finalVideoRelative
      }
    };

    await saveManifest(projectDir, manifestRecord);

    console.log("Cleaning up temporary files...");
    await fsp.rm(TEMP_DIR, { recursive: true, force: true });

    const projects = await listProjects();
    const hydratedManifest = hydrateManifest(manifestRecord, slug);

    const scopeDescription = renderMode === 'missing'
      ? 'missing clips'
      : renderMode === 'range'
        ? `selected clips${renderRangeRaw ? ` (${renderRangeRaw})` : ''}`
        : 'all clips';

    console.log(`Export complete (${scopeDescription}): ${finalVideoName}`);
    res.status(200).json({
      success: true,
      message: `Export complete (${scopeDescription}).`,
      downloadUrl: `/exports/${finalVideoName}`,
      manifest: hydratedManifest,
      projects
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

  const projectName = req.body?.projectName;
  const slug = projectName ? sanitizeProjectName(projectName) : '';

  const imageConfig = plan[imageIndex];
  try {
    await ensureDirectory(EXPORTS_DIR);
    await fsp.rm(TEMP_DIR, { recursive: true, force: true });
    await ensureDirectory(FRAMES_DIR);

    const settings = await loadSettings();
    const resolved = resolveConfigWithDefaults(imageConfig.config || {}, settings.defaultConfig);
    if (!resolved.targetPoint) {
      resolved.targetPoint = { x: 50, y: 50 };
    }

    const absolutePath = await resolveImageAbsolutePath(imageConfig, slug || null);

    await cleanupFramesForIndex(imageIndex);

    const safeId = (imageConfig.id || path.parse(imageConfig.fileName || `image-${imageIndex}`).name)
      .toString()
      .replace(/[^a-z0-9_-]/gi, "_")
      .toLowerCase();
    const outputName = `frame-${safeId}-${Date.now()}.png`;
    const outputPath = path.join(EXPORTS_DIR, outputName);

    let singleProgress = 1;
    const motionStyle = resolved.motionStyle || 'ping-pong';
    if (motionStyle === 'ping-pong') {
      singleProgress = 0.5;
    } else if (motionStyle === 'zoom-out') {
      singleProgress = 0;
    }

    await generateFramesForImage({ ...imageConfig, absolutePath, config: resolved }, imageIndex, {
      singleProgress,
      outputPath,
    });

    await cleanupFramesForIndex(imageIndex);

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
const BASE_DEFAULT_CONFIG = {
  duration: DEFAULT_DURATION,
  zoom: DEFAULT_ZOOM,
  fadeDuration: 0.5,
  motionStyle: "ping-pong",
  lockZoom: false,
  preset: "custom"
};

// Render images at a higher resolution before scaling to smooth zooms.
const RENDER_OVERSAMPLE = Math.max(1, Number(process.env.RENDER_OVERSAMPLE) || 2);

// GPU codec preferences with CPU fallbacks for machines without NVENC.
const NVENC_CODEC = process.env.NVENC_CODEC || "h264_nvenc";
const CPU_FALLBACK_CODEC = "libx264";
const USE_NVENC = process.env.USE_NVENC !== "false";

const SETTINGS_DEFAULTS = {
  defaultConfig: BASE_DEFAULT_CONFIG,
  autoMotion: {
    next: "zoom-in"
  }
};

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
  const fallbackPath = path.join(IMAGES_DIR, imageConfig.fileName);
  const candidatePaths = [];

  if (imageConfig.absolutePath) {
    candidatePaths.push(imageConfig.absolutePath);
  }
  if (!candidatePaths.includes(fallbackPath)) {
    candidatePaths.push(fallbackPath);
  }

  let imageBuffer = null;
  let sourcePath = null;
  for (const candidate of candidatePaths) {
    try {
      imageBuffer = await fsp.readFile(candidate);
      sourcePath = candidate;
      break;
    } catch (err) {
      continue;
    }
  }

  if (!imageBuffer) {
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
function combineClips(clipPaths, plan, options = {}) {
  const outputNamePrefix = options.outputNamePrefix || 'ken-burns-effect';
  const finalOutputName = `${outputNamePrefix}-${Date.now()}.mp4`;
  const finalOutputPath = path.join(EXPORTS_DIR, finalOutputName);

  if (!clipPaths || clipPaths.length === 0) {
    return Promise.reject(new Error("No clips were generated to combine."));
  }

  if (clipPaths.length === 1) {
    return fsp.copyFile(clipPaths[0], finalOutputPath).then(() => finalOutputName);
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
    await ensureDirectory(EXPORTS_DIR);
    await ensureDirectory(OUTPUT_DIR);
    if (!fileExistsSync(IMAGES_DIR)) {
      await ensureDirectory(IMAGES_DIR);
    }
    console.log(`Exports directory ensured at: ${EXPORTS_DIR}`);
    console.log(`Output directory ensured at: ${OUTPUT_DIR}`);

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


