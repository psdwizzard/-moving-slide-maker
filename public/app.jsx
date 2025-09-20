/**
 * Ken Burns Studio frontend
 *
 * Provides gallery management, motion configuration, and preview/export flows
 * that drive the backend render pipeline.
 */

const { useState, useEffect, useMemo, useRef, useCallback } = React;

// Base per-image Ken Burns defaults that also serve as reset values.
const DEFAULT_CONFIG = {
  duration: 6,
  zoom: 1.8,
  arrow: null,
  lockZoom: false,
  fadeDuration: 0.5,
  motionStyle: 'ping-pong',
  preset: 'custom'
};

// Preconfigured motion presets exposed as quick-start buttons in the footer.
const MOTION_PRESETS = [
  { id: 'custom', label: 'Custom 6s', duration: 6, zoom: 1.8, motionStyle: 'ping-pong' },
  { id: 'drift15', label: '15s Drift', duration: 15, zoom: 1.5, motionStyle: 'zoom-in' },
  { id: 'focus30', label: '30s Focus', duration: 30, zoom: 2.0, motionStyle: 'zoom-in' },
  { id: 'linger60', label: '60s Linger', duration: 60, zoom: 1.3, motionStyle: 'zoom-in' }
];

// Human-readable labels for the available motion curves.
const MOTION_STYLES = [
  { id: 'ping-pong', label: 'Zoom In + Out' },
  { id: 'zoom-in', label: 'Zoom In Only' },
  { id: 'zoom-out', label: 'Zoom Out Only' }
];

// Minimum drag distance for future arrow/handle tooling to register.
const MIN_ARROW_LENGTH = 3;

/**
 * Root application shell that manages the gallery, per-image motion settings,
 * and export actions.
 */
function App() {
  const [images, setImages] = useState([]);
  const [selectedImageId, setSelectedImageId] = useState(null);
  const [viewMode, setViewMode] = useState("list");
  const [imageConfigs, setImageConfigs] = useState({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [defaultConfig, setDefaultConfig] = useState(DEFAULT_CONFIG);
  const [projectName, setProjectName] = useState('');
  const [projectSlug, setProjectSlug] = useState(null);
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  const [showProjectsPanel, setShowProjectsPanel] = useState(false);
  const [regeneratingImageId, setRegeneratingImageId] = useState(null);
  const [isSavingDefault, setIsSavingDefault] = useState(false);
  const [exportScope, setExportScope] = useState('all');
  const [exportRange, setExportRange] = useState('');

  // Load the set of available source images when the app boots.
  useEffect(() => {
    fetch("/api/images")
      .then((res) => {
        if (!res.ok) {
          throw new Error("Unable to load images");
        }
        return res.json();
      })
      .then((data) => {
        const hydratedImages = data.map((item) => ({ ...item, clipFile: item.clipFile || null }));
        setImages(hydratedImages);
        if (hydratedImages.length && !selectedImageId) {
          setSelectedImageId(hydratedImages[0].id);
        }
      })
      .catch((error) => {
        setErrorMessage(error.message || "Unknown error loading images");
      });
  }, []);

  useEffect(() => {
    fetch('/api/settings')
      .then((res) => {
        if (!res.ok) {
          throw new Error('Unable to load settings');
        }
        return res.json();
      })
      .then((data) => {
        if (data?.defaultConfig) {
          setDefaultConfig((prev) => ({
            ...prev,
            ...data.defaultConfig
          }));
        }
      })
      .catch((error) => {
        console.warn('Failed to load settings', error);
      });
  }, []);

  const refreshProjects = useCallback(() => {
    fetch('/api/projects')
      .then((res) => {
        if (!res.ok) {
          throw new Error('Unable to load projects');
        }
        return res.json();
      })
      .then((data) => {
        if (Array.isArray(data)) {
          setProjects(data);
        }
      })
      .catch((error) => {
        console.warn('Failed to load projects', error);
      });
  }, []);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    if (!images.length) {
      setSelectedImageId(null);
      return;
    }
    if (!images.some((img) => img.id === selectedImageId)) {
      setSelectedImageId(images[0].id);
    }
  }, [images, selectedImageId]);

  // Convenience pointer to whichever image is selected in the gallery.
  const selectedImage = useMemo(() => {
    return images.find((img) => img.id === selectedImageId) || null;
  }, [images, selectedImageId]);

  // Merge stored overrides with defaults to drive the inspector UI.
  const selectedConfig = useMemo(() => {
    if (!selectedImageId) {
      return defaultConfig;
    }
    return {
      ...defaultConfig,
      ...imageConfigs[selectedImageId]
    };
  }, [defaultConfig, imageConfigs, selectedImageId]);

  // Persist partial updates for the active image and mark preset as custom when needed.
  const updateImageConfig = (imageId, patch) => {
    if (!imageId) {
      return;
    }
    const normalizedPatch = { ...patch };
    const touchesCoreMotion = ['duration', 'zoom', 'motionStyle', 'fadeDuration'].some((key) => key in normalizedPatch);
    if (touchesCoreMotion && !('preset' in normalizedPatch)) {
      normalizedPatch.preset = 'custom';
    }
    setImageConfigs((prev) => {
      const current = prev[imageId] || {};
      return {
        ...prev,
        [imageId]: {
          ...defaultConfig,
          ...current,
          ...normalizedPatch
        }
      };
    });
  };

  // Resolve the currently-active preset metadata for footer messaging.
  const selectedPreset = useMemo(() => {
    return MOTION_PRESETS.find((preset) => preset.id === selectedConfig.preset) || MOTION_PRESETS[0];
  }, [selectedConfig.preset]);

  const isCustomPreset = selectedConfig.preset === 'custom';

  const projectImageMap = useMemo(() => {
    if (!activeProject || !Array.isArray(activeProject.images)) {
      return {};
    }
    return activeProject.images.reduce((acc, item) => {
      acc[item.id] = item;
      return acc;
    }, {});
  }, [activeProject]);

  const normalizeManifestImages = useCallback((manifest) => {
    if (!manifest || !Array.isArray(manifest.images)) {
      return [];
    }
    const slug = manifest.slug || null;
    return manifest.images.map((item) => {
      const relativePath = (item.imagePath || `images/${item.fileName || ''}`).replace(/\\/g, '/');
      let url = item.imageUrl || '';
      if (!url && slug) {
        const segments = [slug, ...relativePath.split('/').filter(Boolean)];
        url = `/projects/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
      }
      return {
        id: item.id,
        fileName: item.fileName,
        url,
        thumbnailUrl: url,
        size: item.size ?? 0,
        imagePath: relativePath,
        clipFile: item.clipFile || null
      };
    });
  }, []);

  // Apply the chosen preset values to the current image.
  const handleApplyPreset = (preset) => {
    if (!selectedImageId) {
      return;
    }
    updateImageConfig(selectedImageId, {
      preset: preset.id,
      duration: preset.duration,
      zoom: preset.zoom,
      motionStyle: preset.motionStyle
    });
  };

  const handleContinue = useCallback(() => {
    if (!images.length || !selectedImageId) {
      return;
    }
    const currentIndex = images.findIndex((img) => img.id === selectedImageId);
    if (currentIndex === -1) {
      return;
    }
    const total = images.length;
    for (let offset = 1; offset <= total; offset++) {
      const nextIndex = (currentIndex + offset) % total;
      const candidate = images[nextIndex];
      const clipInfo = projectImageMap[candidate.id];
      if (!clipInfo?.clipFile) {
        setSelectedImageId(candidate.id);
        return;
      }
    }
    const fallbackIndex = (currentIndex + 1) % total;
    setSelectedImageId(images[fallbackIndex].id);
  }, [images, selectedImageId, projectImageMap]);

  const handleExportScopeChange = useCallback((event) => {
    const nextScope = event.target.value;
    setExportScope(nextScope);
    if (nextScope !== 'range') {
      setExportRange('');
    }
  }, []);

  const isRangeMode = exportScope === 'range';
  const exportButtonDisabled =
    isExporting || !projectName.trim() || (isRangeMode && !exportRange.trim());
  const exportButtonTitle = !projectName.trim()
    ? 'Enter a project name first'
    : isRangeMode && !exportRange.trim()
      ? 'Specify clip indices (e.g. 1-4,6)'
      : undefined;

  // Compose the payload consumed by the export endpoints.
  const buildPlanPayload = useCallback(() => {
    const trimmedName = projectName.trim();
    return {
      ...(trimmedName ? { projectName: trimmedName } : {}),
      plan: images.map((image) => ({
        id: image.id,
        fileName: image.fileName,
        imagePath: image.imagePath || null,
        clipFile: image.clipFile || null,
        size: image.size,
        config: {
          ...defaultConfig,
          ...imageConfigs[image.id]
        }
      }))
    };
  }, [defaultConfig, imageConfigs, images, projectName]);

  // Trigger the MP4 render flow on the backend.
  const handleExportVideo = async () => {
    const trimmedName = projectName.trim();
    if (!trimmedName) {
      setExportStatus('Name your project before exporting.');
      return;
    }

    if (exportScope === 'range' && !exportRange.trim()) {
      setExportStatus('Specify which clips to render (e.g. 1-4,6).');
      return;
    }

    setIsExporting(true);
    const trimmedRange = exportRange.trim();
    const scopedStatus = exportScope === 'missing'
      ? 'Rendering missing clips...'
      : exportScope === 'range'
        ? `Rendering selected clips${trimmedRange ? ` (${trimmedRange})` : ''}...`
        : 'Rendering all clips...';
    setExportStatus(scopedStatus);

    const payload = {
      ...buildPlanPayload(),
      projectName: trimmedName,
      renderMode: exportScope,
      ...(exportScope === 'range' ? { renderRange: trimmedRange } : {})
    };

    try {
      const response = await fetch('/api/export-video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || 'Failed to start export');
      }

      if (result.manifest) {
        setActiveProject(result.manifest);
        setProjectSlug(result.manifest.slug || null);
        setProjectName(result.manifest.name || trimmedName);
        setImages(normalizeManifestImages(result.manifest));
        const nextConfigs = {};
        (result.manifest.images || []).forEach((item) => {
          nextConfigs[item.id] = item.config;
        });
        setImageConfigs((prev) => ({
          ...prev,
          ...nextConfigs
        }));
      }

      if (Array.isArray(result.projects)) {
        setProjects(result.projects);
      } else {
        refreshProjects();
      }

      const completedMessage = result.message || 'Export complete!';
      if (result.downloadUrl) {
        setExportStatus(`${completedMessage} Download: ${result.downloadUrl}`);
      } else {
        setExportStatus(completedMessage);
      }
    } catch (error) {
      setExportStatus(`Error: ${error.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleRegenerateClip = async (imageId) => {
    if (!imageId) {
      return;
    }
    if (!projectSlug) {
      setExportStatus('Load or export a project before regenerating clips.');
      return;
    }

    setRegeneratingImageId(imageId);
    setExportStatus('Regenerating clip...');

    const payload = {
      imageId,
      config: {
        ...defaultConfig,
        ...imageConfigs[imageId]
      }
    };

    try {
      const response = await fetch(`/api/projects/${projectSlug}/regenerate-clip`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || result.message || 'Clip regeneration failed');
      }

      if (result.manifest) {
        setActiveProject(result.manifest);
        setProjectSlug(result.manifest.slug || projectSlug);
        if (result.manifest.name) {
          setProjectName(result.manifest.name);
        }
        setImages(normalizeManifestImages(result.manifest));
        const nextConfigs = {};
        (result.manifest.images || []).forEach((item) => {
          nextConfigs[item.id] = item.config;
        });
        setImageConfigs((prev) => ({
          ...prev,
          ...nextConfigs
        }));
      }

      if (Array.isArray(result.projects)) {
        setProjects(result.projects);
      } else {
        refreshProjects();
      }

      setExportStatus(result.message || 'Clip regenerated.');
    } catch (error) {
      setExportStatus(`Clip regeneration failed: ${error.message}`);
    } finally {
      setRegeneratingImageId(null);
    }
  };

  const handleLoadProject = async (slug) => {
    if (!slug) {
      return;
    }

    try {
      const response = await fetch(`/api/projects/${slug}`);
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Unable to load project');
      }

      setActiveProject(result);
      setProjectSlug(result.slug || slug);
      if (result.name) {
        setProjectName(result.name);
      }

      setImages(normalizeManifestImages(result));
      const nextConfigs = {};
      (result.images || []).forEach((item) => {
        nextConfigs[item.id] = item.config;
      });
      setImageConfigs((prev) => ({
        ...prev,
        ...nextConfigs
      }));

      if (result.images && result.images.length) {
        const availableIds = result.images.map((item) => item.id);
        if (!availableIds.includes(selectedImageId)) {
          const fallbackId = availableIds.find((id) => images.some((img) => img.id === id));
          if (fallbackId) {
            setSelectedImageId(fallbackId);
          }
        }
      }

      setExportStatus(`Loaded project ${result.name || slug}`);
      refreshProjects();
    } catch (error) {
      setExportStatus(`Failed to load project: ${error.message}`);
    } finally {
      setShowProjectsPanel(false);
    }
  };

  const handleSaveDefault = async () => {
    setIsSavingDefault(true);
    const payload = {
      defaultConfig: {
        duration: selectedConfig.duration,
        zoom: selectedConfig.zoom,
        fadeDuration: selectedConfig.fadeDuration,
        motionStyle: selectedConfig.motionStyle,
        lockZoom: selectedConfig.lockZoom,
        preset: selectedConfig.preset
      }
    };

    try {
      const response = await fetch('/api/settings/default-config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || result.message || 'Unable to save default');
      }
      if (result.defaultConfig) {
        setDefaultConfig((prev) => ({
          ...prev,
          ...result.defaultConfig
        }));
      }
      setExportStatus('Saved default configuration.');
    } catch (error) {
      setExportStatus(`Failed to save default: ${error.message}`);
    } finally {
      setIsSavingDefault(false);
    }
  };

  // Ask the server for a single rendered frame preview of the focused image.
  const handleExportFrame = async () => {
    if (!selectedImageId) {
      setExportStatus('Select an image before exporting a frame.');
      return;
    }

    setIsExporting(true);
    setExportStatus('Rendering single frame...');

    const payload = {
      ...buildPlanPayload(),
      singleFrame: selectedImageId
    };

    try {
      const response = await fetch('/api/export-frame', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || 'Failed to export frame');
      }

      if (result.downloadUrl) {
        setExportStatus(`Frame ready: ${result.downloadUrl}`);
      } else {
        setExportStatus(result.message || 'Frame rendered.');
      }
    } catch (error) {
      setExportStatus(`Error: ${error.message}`);
    }

    setIsExporting(false);
  };

  // Download the current plan as JSON for debugging or hand-off.
  const handleExport = () => {
    const payload = buildPlanPayload();
    const safeName = payload.projectName ? payload.projectName.replace(/[^a-z0-9_-]/gi, '_') : 'ken-burns-plan';

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeName}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setExportStatus('Exported configuration JSON');
  };

  return (
    <div className="App">
      <header className="App__header">
        <div className="App__headerMain">
          <div className="App__titleGroup">
            <h1>Moving Slide Maker</h1>
            <div className="App__projectControls">
              <label>
                Project
                <input
                  type="text"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="Untitled project"
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  refreshProjects();
                  setShowProjectsPanel(true);
                }}
              >
                Browse Projects
              </button>
            </div>
          </div>
          <div className="App__layoutToggle">
            <button
              className={viewMode === "grid" ? "active" : ""}
              onClick={() => setViewMode("grid")}
            >
              Grid
            </button>
            <button
              className={viewMode === "list" ? "active" : ""}
              onClick={() => setViewMode("list")}
            >
              List
            </button>
          </div>
        </div>
        <div className="App__headerActions">
          <button onClick={handleExport}>Export JSON</button>
        </div>
      </header>

      {showProjectsPanel && (
        <ProjectsPanel
          projects={projects}
          activeSlug={projectSlug}
          onSelect={(slug) => handleLoadProject(slug)}
          onClose={() => setShowProjectsPanel(false)}
        />
      )}

      <div className="App__body">
        <aside className={`Gallery Gallery--${viewMode}`}>
          {errorMessage && (
            <div className="Gallery__error">{errorMessage}</div>
          )}
          {images.map((image) => (
            <button
              key={image.id}
              className={
                "Gallery__item" +
                (image.id === selectedImageId ? " Gallery__item--active" : "")
              }
              onClick={() => setSelectedImageId(image.id)}
            >
              <img src={image.thumbnailUrl} alt={image.fileName} />
              <span className="Gallery__itemLabel">
                {image.fileName}
                {projectImageMap[image.id]?.clipFile && (
                  <span className="Gallery__badge">Saved</span>
                )}
              </span>
            </button>
          ))}
        </aside>

        <main className="Viewer">
          {selectedImage ? (
            <MainViewer
              image={selectedImage}
              config={selectedConfig}
              clipInfo={projectImageMap[selectedImage.id]}
              canRegenerate={Boolean(projectSlug)}
              isRegenerating={regeneratingImageId === selectedImageId}
              isExporting={isExporting}
              isClipDone={Boolean(projectImageMap[selectedImage.id]?.clipFile)}
              canContinue={images.length > 1}
              onRegenerateClip={() => handleRegenerateClip(selectedImageId)}
              onUpdateConfig={(patch) => updateImageConfig(selectedImageId, patch)}
              onContinue={handleContinue}
            />
          ) : (
            <div className="Viewer__empty">Select an image to begin</div>
          )}
        </main>
      </div>

      <footer className="App__footer">
        <div className="Toolbar">
          <div className="Toolbar__group Toolbar__group--presets">
            <span className="Toolbar__label">Motion Presets</span>
            {MOTION_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className={selectedConfig.preset === preset.id ? "active" : ""}
                onClick={() => handleApplyPreset(preset)}
                disabled={!selectedImageId}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {!isCustomPreset && (
            <div className="Toolbar__note">
              Preset values are locked (using {selectedPreset.label}). Choose "Custom 6s" to tweak duration or zoom.
            </div>
          )}

          <div className="Toolbar__group">
            <label>
              Duration (s)
              <input
                type="number"
                min="1"
                max="120"
                step="0.5"
                value={selectedConfig.duration}
                onChange={(event) =>
                  updateImageConfig(selectedImageId, {
                    duration: parseFloat(event.target.value) || 1
                  })
                }
                disabled={!selectedImageId}
              />
            </label>
            <label>
              Zoom
              <input
                type="range"
                min="1"
                max="3.5"
                step="0.1"
                value={selectedConfig.zoom}
                onChange={(event) =>
                  updateImageConfig(selectedImageId, {
                    zoom: parseFloat(event.target.value) || 1
                  })
                }
                disabled={!selectedImageId}
              />
              <span className="Toolbar__value">{selectedConfig.zoom.toFixed(1)}x</span>
            </label>
            <label>
              Motion
              <select
                value={selectedConfig.motionStyle}
                onChange={(event) =>
                  updateImageConfig(selectedImageId, { motionStyle: event.target.value })
                }
                disabled={!selectedImageId}
              >
                {MOTION_STYLES.map((style) => (
                  <option key={style.id} value={style.id}>
                    {style.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Fade (s)
              <input
                type="number"
                min="0"
                max="10"
                step="0.1"
                value={selectedConfig.fadeDuration}
                onChange={(event) =>
                  updateImageConfig(selectedImageId, {
                    fadeDuration: parseFloat(event.target.value) || 0
                  })
                }
                disabled={!selectedImageId}
              />
            </label>
            <label className="Toolbar__toggle">
              <input
                type="checkbox"
                checked={selectedConfig.lockZoom}
                onChange={(event) =>
                  updateImageConfig(selectedImageId, {
                    lockZoom: event.target.checked
                  })
                }
                disabled={!selectedImageId}
              />
              <span>Stay zoomed after preview</span>
            </label>
            <button
              type="button"
              className="Toolbar__secondaryButton"
              onClick={handleSaveDefault}
              disabled={isSavingDefault}
            >
              {isSavingDefault ? 'Saving?' : 'Save as Default'}
            </button>
          </div>

          <div className="Toolbar__group Toolbar__group--actions">
            <div className="Toolbar__exportOptions">
              <label>
                Mode
                <select
                  value={exportScope}
                  onChange={handleExportScopeChange}
                  disabled={isExporting}
                >
                  <option value="all">Render all clips</option>
                  <option value="missing">Render missing clips</option>
                  <option value="range">Render specific clips</option>
                </select>
              </label>
              {isRangeMode && (
                <label className="Toolbar__rangeInput">
                  Range
                  <input
                    type="text"
                    value={exportRange}
                    onChange={(event) => setExportRange(event.target.value)}
                    placeholder="e.g. 1-4,6,9"
                    disabled={isExporting}
                  />
                </label>
              )}
            </div>
            <button
              onClick={handleExportVideo}
              disabled={exportButtonDisabled}
              title={exportButtonTitle}
            >
              {isExporting ? 'Exporting...' : 'Export MP4'}
            </button>
          </div>
        </div>
        {exportStatus && <div className="App__status">{exportStatus}</div>}
      </footer>

    </div>
  );
}

function ProjectsPanel({ projects, activeSlug, onSelect, onClose }) {
  return (
    <div className="ProjectsPanel">
      <div className="ProjectsPanel__inner">
        <div className="ProjectsPanel__header">
          <h2>Saved Projects</h2>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <div className="ProjectsPanel__list">
          {projects.length === 0 ? (
            <div className="ProjectsPanel__empty">No exports saved yet.</div>
          ) : (
            projects.map((project) => {
              const updatedAt = project.updatedAt || project.createdAt;
              const formattedDate = updatedAt ? new Date(updatedAt).toLocaleString() : 'Unknown';
              const isActive = project.slug === activeSlug;
              return (
                <button
                  key={project.slug}
                  type="button"
                  className={
                    'ProjectsPanel__item' + (isActive ? ' ProjectsPanel__item--active' : '')
                  }
                  onClick={() => onSelect(project.slug)}
                >
                  <span className="ProjectsPanel__name">{project.name || project.slug}</span>
                  <span className="ProjectsPanel__meta">
                    {project.clipCount || 0} clip{project.clipCount === 1 ? '' : 's'} ? {formattedDate}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// Displays a crosshair showing where the zoom animation will focus.
function TargetMarker({ point, metrics }) {
  if (!point || !metrics) return null;

  const projectPoint = (p) => {
    if (!metrics || !metrics.stageWidth || !metrics.stageHeight) {
      return p;
    }
    const anchorX = metrics.offsetX + (p.x / 100) * metrics.displayWidth;
    const anchorY = metrics.offsetY + (p.y / 100) * metrics.displayHeight;
    return {
      x: (anchorX / metrics.stageWidth) * 100,
      y: (anchorY / metrics.stageHeight) * 100
    };
  };

  const p = projectPoint(point);
  const size = 2.5;

  return (
    <svg className="TargetMarker" viewBox="0 0 100 100" preserveAspectRatio="none">
      <line x1={p.x - size} y1={p.y - size} x2={p.x + size} y2={p.y + size} />
      <line x1={p.x - size} y1={p.y + size} x2={p.x + size} y2={p.y - size} />
    </svg>
  );
}

// Highlights the portion of the image visible at the target zoom level.
function ActiveAreaOverlay({ metrics, zoom, targetPoint }) {
    if (!metrics || !targetPoint || zoom <= 1) {
        return null;
    }

    const { stageWidth, stageHeight, displayWidth, displayHeight, offsetX, offsetY } = metrics;

    const areaWidth = stageWidth / zoom;
    const areaHeight = stageHeight / zoom;

    const targetX = offsetX + (targetPoint.x / 100) * displayWidth;
    const targetY = offsetY + (targetPoint.y / 100) * displayHeight;

    let areaX = targetX - areaWidth / 2;
    let areaY = targetY - areaHeight / 2;
    
    areaX = clamp(areaX, offsetX, offsetX + displayWidth - areaWidth);
    areaY = clamp(areaY, offsetY, offsetY + displayHeight - areaHeight);

    const style = {
        left: `${areaX}px`,
        top: `${areaY}px`,
        width: `${areaWidth}px`,
        height: `${areaHeight}px`,
    };

    return <div className="ActiveAreaOverlay" style={style} />;
}

/**
 * Primary editing surface that wires pointer events, live preview playback,
 * and metric calculations for the selected image.
 */
function MainViewer({ image, config, onUpdateConfig, clipInfo, onRegenerateClip, isRegenerating, canRegenerate, isExporting, isClipDone, onContinue, canContinue }) {
  const containerRef = useRef(null);
  const imgRef = useRef(null);
  const [imageMetrics, setImageMetrics] = useState(null);
  const [currentZoom, setCurrentZoom] = useState(1);
  const animationFrameRef = useRef(null);

  // Stop any in-flight preview animation before resetting state.
  const cancelAnimation = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    setCurrentZoom(1);
  }, []);

  // Measure how the rendered image sits inside the stage for accurate math.
  const updateImageMetrics = useCallback(() => {
    if (!containerRef.current || !imgRef.current) {
      return;
    }
    const stageRect = containerRef.current.getBoundingClientRect();
    const imageRect = imgRef.current.getBoundingClientRect();
    if (!imageRect.width || !imageRect.height) {
      return;
    }
    setImageMetrics({
      stageWidth: stageRect.width,
      stageHeight: stageRect.height,
      offsetX: imageRect.left - stageRect.left,
      offsetY: imageRect.top - stageRect.top,
      displayWidth: imageRect.width,
      displayHeight: imageRect.height,
      naturalWidth: imgRef.current.naturalWidth || imageRect.width,
      naturalHeight: imgRef.current.naturalHeight || imageRect.height
    });
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    // Recompute metrics whenever the stage resizes.
    if (!element) {
      return;
    }

    updateImageMetrics();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        window.requestAnimationFrame(updateImageMetrics);
      });
      observer.observe(element);
      return () => observer.disconnect();
    }

    const handler = () => window.requestAnimationFrame(updateImageMetrics);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("resize", handler);
    };
  }, [updateImageMetrics]);

  useEffect(() => {
    // Reset preview state when switching to a different image.
    cancelAnimation();
    window.requestAnimationFrame(updateImageMetrics);
  }, [image.id, cancelAnimation, updateImageMetrics]);

  useEffect(() => {
    return () => {
      cancelAnimation();
    };
  }, [cancelAnimation]);

  // Skip pointer math until we know how the image maps into the viewport.
  const metricsReady = Boolean(
    imageMetrics &&
      imageMetrics.displayWidth &&
      imageMetrics.displayHeight &&
      imageMetrics.stageWidth &&
      imageMetrics.stageHeight
  );

  // Convert user clicks into normalized coordinates for the zoom target.
  const handleStageClick = (event) => {
    if (!metricsReady) {
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    cancelAnimation();
    const targetPoint = getRelativePoint(event, containerRef.current, imageMetrics);
    onUpdateConfig({ targetPoint, arrow: null });
  };

  // Remove the focus target and reset any preview zoom.
  const handleClearTarget = () => {
    cancelAnimation();
    onUpdateConfig({ targetPoint: null, arrow: null });
  };

  // Manually drive a requestAnimationFrame loop to mimic the final animation.
  const handlePreview = () => {
    if (!config.targetPoint || !metricsReady) {
      return;
    }
    cancelAnimation();

    const motionStyle = config.motionStyle || 'ping-pong';
    const startZoom = motionStyle === 'zoom-out' ? config.zoom : 1;
    const endZoom = motionStyle === 'zoom-out' ? 1 : config.zoom;

    let startTime = null;
    const animate = (timestamp) => {
      if (!startTime) {
        startTime = timestamp;
      }
      const elapsed = timestamp - startTime;
      const progress = Math.min(elapsed / (config.duration * 1000), 1);

      let eased = 0;
      if (motionStyle === 'ping-pong') {
        const pingPongProgress = progress < 0.5 ? progress * 2 : (1 - progress) * 2;
        eased = easeInOut(pingPongProgress);
      } else {
        eased = easeInOut(progress);
      }

      const zoom = startZoom + (endZoom - startZoom) * eased;
      setCurrentZoom(zoom);

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      } else {
        setCurrentZoom(config.lockZoom ? endZoom : 1);
        animationFrameRef.current = null;
      }
    };

    animationFrameRef.current = requestAnimationFrame(animate);
  };

  // Mirror the backend transform math so previews match exports.
  const transformProps = getKenBurnsTransform(
    config.targetPoint,
    imageMetrics,
    currentZoom
  );

  const transformStyle = (config.targetPoint && metricsReady)
    // When we have a target, lock the transform to the calculated origin.
    ? {
        transformOrigin: transformProps.transformOrigin,
        transform: transformProps.transform,
        transition: 'none' // Animation is now manual
      }
    : {
        transformOrigin: "50% 50%",
        transform: "scale(1)",
        transition: "none"
      };

  const stageClassName = `Viewer__stage`;
  const hintMessage = !metricsReady
    // Provide contextual guidance while the user sets up an image.
    ? "Loading image metrics..."
    : config.targetPoint
    ? "Click to change the zoom target"
    : "Click to set the zoom target";

  return (
    <div className="Viewer__content">
      <div
        className={stageClassName}
        ref={containerRef}
        onClick={handleStageClick}
        onDragStart={(event) => event.preventDefault()}
      >
        <div className="Viewer__imageWrapper" style={transformStyle}>
          <img
            ref={imgRef}
            src={image.url}
            alt={image.fileName}
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
            onLoad={() => {
              window.requestAnimationFrame(updateImageMetrics);
            }}
          />
        </div>
        <ActiveAreaOverlay metrics={imageMetrics} zoom={config.zoom} targetPoint={config.targetPoint} />
        <TargetMarker point={config.targetPoint} metrics={imageMetrics} />
        {hintMessage && <div className="Viewer__hint">{hintMessage}</div>}
      </div>
      <div className="Viewer__controls">
        <div className="Viewer__meta">
          <h2>{image.fileName}</h2>
          <p>{(image.size / 1024 ** 2).toFixed(1)} MB</p>
          {canRegenerate && (
            <p className="Viewer__clipMeta">
              {clipInfo?.clipFile ? `Clip: ${clipInfo.clipFile}` : 'No clip saved yet'}
            </p>
          )}
          {canRegenerate && (
            <label className="Viewer__doneToggle">
              <input type="checkbox" checked={Boolean(isClipDone)} readOnly disabled />
              Clip done
            </label>
          )}
        </div>
        <div className="Viewer__buttons">
          <button onClick={handlePreview} disabled={!config.targetPoint || !metricsReady}>
            Preview Zoom
          </button>
          <button onClick={handleClearTarget} disabled={!config.targetPoint}>
            Clear Target
          </button>
          {onRegenerateClip && (
            <button
              onClick={onRegenerateClip}
              disabled={!canRegenerate || isRegenerating || isExporting}
            >
              {isRegenerating ? 'Regenerating?' : 'Regenerate Clip'}
            </button>
          )}
          {onContinue && (
            <button
              onClick={onContinue}
              disabled={!canContinue}
            >
              Continue
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Compute the CSS transform that keeps the focus point centered during zooming.
function getKenBurnsTransform(targetPoint, metrics, scale) {
  if (!targetPoint || !metrics || !metrics.stageWidth || !metrics.stageHeight) {
    return {
      transform: "scale(1)",
      transformOrigin: "50% 50%",
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

  if (scaledTopLeftX > 0) {
    translateX -= scaledTopLeftX;
  }
  if (scaledBottomRightX < metrics.stageWidth) {
    translateX += metrics.stageWidth - scaledBottomRightX;
  }
  if (scaledTopLeftY > 0) {
    translateY -= scaledTopLeftY;
  }
  if (scaledBottomRightY < metrics.stageHeight) {
    translateY += metrics.stageHeight - scaledBottomRightY;
  }

  const transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;

  return { transform, transformOrigin };
}

// Translate pointer coordinates into 0-100 percentages relative to the displayed image.
function getRelativePoint(event, container, metrics) {
  const rect = container.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  const localY = event.clientY - rect.top;

  if (metrics && metrics.displayWidth && metrics.displayHeight) {
    const normalizedX =
      (localX - metrics.offsetX) / (metrics.displayWidth || rect.width);
    const normalizedY =
      (localY - metrics.offsetY) / (metrics.displayHeight || rect.height);
    return {
      x: clamp(Number.isFinite(normalizedX) ? normalizedX * 100 : 0, 0, 100),
      y: clamp(Number.isFinite(normalizedY) ? normalizedY * 100 : 0, 0, 100)
    };
  }

  return {
    x: clamp((localX / rect.width) * 100, 0, 100),
    y: clamp((localY / rect.height) * 100, 0, 100)
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Numeric cubic-bezier solver so the preview matches CSS ease-in-out timing.
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

// Helper kept around for measuring cursor distances in percent space (used by previous tooling).
function distancePercent(a, b) {
  if (!a || !b) {
    return 0;
  }
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);