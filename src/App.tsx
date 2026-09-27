import { useState, useRef, useEffect, useSyncExternalStore } from 'react';
import {
  LidarPoint,
  LidarMetadata,
  LidarFilterState,
  LidarRenderSettings,
  EditingMode,
  AgentAction
} from './types/lidar';
import { generateSampleDataset, SAMPLE_PRESETS } from './data/sampleLidar';
import { DEFAULT_SCAN_ID, SCAN_DATASETS, findScan } from './data/scans';
import {
  parseLasFile,
  parsePlyFile,
  parseXyzFile,
  exportToLas,
  exportToPly,
  exportToXyz
} from './utils/lidarParser';
import {
  listClouds,
  uploadCloud,
  loadHierarchy,
  octreeMetadata,
  octreeUrl,
  sourceE57Url,
  bagFolderFiles,
  UploadedCloud,
  CloudProgress
} from './utils/cloudApi';
import { OctreeHierarchy } from './utils/octree';
import { clusterPoints, describeCluster, pickCluster } from './utils/cluster';
import { LidarViewport } from './components/LidarViewport';
import { OctreeViewport } from './components/OctreeViewport';
import { LidarControlsPanel } from './components/LidarControlsPanel';
import { LidarAgentChat } from './components/LidarAgentChat';
import { PhotorealStudio } from './components/PhotorealStudio';
import { PhotorealStage } from './components/PhotorealStage';
import { usePhotoreal } from './hooks/usePhotoreal';
import { ViewportCaptureFn } from './types/photoreal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Download, FolderUp, Loader2, SlidersHorizontal, Sparkles, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

const PHONE_QUERY = '(max-width: 639px)';
const DEFAULT_POINT_SIZE = 0.5;

function useIsPhone() {
  return useSyncExternalStore(
    cb => {
      const mql = window.matchMedia(PHONE_QUERY);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    () => window.matchMedia(PHONE_QUERY).matches
  );
}

export default function App() {
  const isPhone = useIsPhone();
  const [activePresetId, setActivePresetId] = useState<string>(DEFAULT_SCAN_ID);
  const [loadingScan, setLoadingScan] = useState<string | null>(findScan(DEFAULT_SCAN_ID)?.name ?? null);
  const initialData = useRef(generateSampleDataset('urban_aerial'));

  const [points, setPoints] = useState<LidarPoint[]>(initialData.current.points);
  const [metadata, setMetadata] = useState<LidarMetadata>(initialData.current.metadata);

  const originalPointsRef = useRef<LidarPoint[]>(initialData.current.points);

  const [filterState, setFilterState] = useState<LidarFilterState>({
    elevationMin: initialData.current.metadata.bounds.minZ,
    elevationMax: initialData.current.metadata.bounds.maxZ,
    intensityMin: initialData.current.metadata.intensityRange[0],
    intensityMax: initialData.current.metadata.intensityRange[1],
    enabledClasses: new Set(Object.keys(initialData.current.metadata.classCounts).map(Number)),
    cropBoxEnabled: false,
    cropBoxMin: [
      initialData.current.metadata.bounds.minX * 0.6,
      initialData.current.metadata.bounds.minY * 0.6,
      initialData.current.metadata.bounds.minZ
    ],
    cropBoxMax: [
      initialData.current.metadata.bounds.maxX * 0.6,
      initialData.current.metadata.bounds.maxY * 0.6,
      initialData.current.metadata.bounds.maxZ
    ],
    decimationRate: 1.0
  });

  const [renderSettings, setRenderSettings] = useState<LidarRenderSettings>({
    colorMode: 'classification',
    colormap: 'viridis',
    pointSize: DEFAULT_POINT_SIZE,
    sizeAttenuation: true,
    edlEnabled: true,
    edlRadius: 1.5,
    edlStrength: 1.0,
    invertColormap: false,
    backgroundColor: '#111217'
  });

  const [editingMode, setEditingMode] = useState<EditingMode>('navigate');
  const [controlsOpen, setControlsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Server-side scans (.e57 / databag uploads, streamed as a level-of-detail octree)
  const [uploadedClouds, setUploadedClouds] = useState<UploadedCloud[]>([]);
  const [streamed, setStreamed] = useState<{ cloud: UploadedCloud; hierarchy: OctreeHierarchy } | null>(null);
  const [importStatus, setImportStatus] = useState<{ label: string; progress?: CloudProgress; error?: string } | null>(null);

  const refreshUploadedClouds = () =>
    listClouds()
      .then(setUploadedClouds)
      .catch(err => console.warn('Could not list uploaded clouds:', err));

  useEffect(() => {
    refreshUploadedClouds();
  }, []);
  const [rightPane, setRightPane] = useState<'agent' | 'photoreal'>('agent');
  const captureRef = useRef<ViewportCaptureFn | null>(null);
  const photorealSceneHint =
    findScan(activePresetId)?.description ??
    (metadata.format === 'SYNTHETIC' ? SAMPLE_PRESETS.find(p => p.id === activePresetId)?.description ?? '' : '');
  const photoreal = usePhotoreal({
    captureRef,
    metadata,
    filterState,
    renderSettings,
    defaultScene: photorealSceneHint
  });

  // Back to the in-memory viewer (presets and small local files)
  const leaveStreamedCloud = () => {
    if (!streamed) return;
    setStreamed(null);
    setRenderSettings(prev => ({ ...prev, pointSize: 0.5, edlStrength: 1.0 }));
  };

  const handleLoadUploadedCloud = async (cloud: UploadedCloud) => {
    setImportStatus({ label: `Loading ${cloud.name}` });
    try {
      const hierarchy = await loadHierarchy(cloud);
      const meta = octreeMetadata(cloud, hierarchy);
      setPoints([]);
      originalPointsRef.current = [];
      setMetadata(meta);
      resetFilterStateForNewCloud(meta);
      setRenderSettings(prev => ({
        ...prev,
        colorMode: meta.hasRGB ? 'rgb' : 'elevation',
        pointSize: 2,
        edlEnabled: true,
        edlStrength: 0.4
      }));
      setStreamed({ cloud, hierarchy });
      setActivePresetId(`cloud:${cloud.id}`);
      setImportStatus(null);
    } catch (err: any) {
      setImportStatus({ label: cloud.name, error: err.message || String(err) });
    }
  };

  const handleUploadCloud = async (files: File[], name: string) => {
    setImportStatus({ label: name, progress: { phase: 'uploading', fraction: 0 } });
    try {
      const cloud = await uploadCloud(files, name, progress => setImportStatus({ label: name, progress }));
      await refreshUploadedClouds();
      await handleLoadUploadedCloud(cloud);
      toast.success(`${name} is ready`, { description: `${cloud.summary?.pointCount.toLocaleString()} points` });
    } catch (err: any) {
      setImportStatus({ label: name, error: err.message || String(err) });
    }
  };

  // Databag folders and .e57 scans go to the server; other formats load in the browser
  const handleImportFiles = async (files: File[]) => {
    const bagFiles = bagFolderFiles(files);
    if (bagFiles.some(f => /\.bag$/i.test(f.name))) {
      const folder = files[0].webkitRelativePath?.split('/')[0] || bagFiles[0].name.replace(/\.bag$/i, '');
      await handleUploadCloud(bagFiles, folder);
    } else if (files[0]?.name.toLowerCase().endsWith('.e57')) {
      await handleUploadCloud([files[0]], files[0].name);
    } else if (files[0]) {
      await handleImportFile(files[0]);
    }
  };

  const applyParsed = (parsed: { points: LidarPoint[]; metadata: LidarMetadata }) => {
    setPoints(parsed.points);
    setMetadata(parsed.metadata);
    originalPointsRef.current = parsed.points;
    resetFilterStateForNewCloud(parsed.metadata);
  };

  /** Scans ship as .ply in public/scans and are fetched on demand. */
  const handleLoadScan = async (scanId: string) => {
    const scan = findScan(scanId);
    if (!scan) return;
    setActivePresetId(scanId);
    setLoadingScan(scan.name);
    try {
      const response = await fetch(scan.url);
      if (!response.ok) throw new Error(`Server returned status ${response.status}`);
      const parsed = parsePlyFile(await response.arrayBuffer(), scan.name);
      applyParsed(parsed);
      setRenderSettings(prev => ({
        ...prev,
        colorMode: scan.recommendedColorMode,
        colormap: scan.recommendedColormap,
        pointSize: scan.pointSize,
        structureOpacity: scan.structureOpacity
      }));
    } catch (err: any) {
      toast.error(`Could not load ${scan.name}`, { description: String(err.message || err) });
    } finally {
      setLoadingScan(null);
    }
  };

  useEffect(() => {
    handleLoadScan(DEFAULT_SCAN_ID);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLoadPreset = (presetId: string) => {
    if (presetId.startsWith('cloud:')) {
      const cloud = uploadedClouds.find(c => `cloud:${c.id}` === presetId);
      if (cloud) handleLoadUploadedCloud(cloud);
      return;
    }
    leaveStreamedCloud();
    if (findScan(presetId)) {
      handleLoadScan(presetId);
      return;
    }
    setActivePresetId(presetId);
    const parsed = generateSampleDataset(presetId);
    setPoints(parsed.points);
    setMetadata(parsed.metadata);
    originalPointsRef.current = parsed.points;

    const presetConfig = SAMPLE_PRESETS.find(p => p.id === presetId);
    if (presetConfig) {
      setRenderSettings(prev => ({
        ...prev,
        colorMode: presetConfig.recommendedColorMode,
        colormap: presetConfig.recommendedColormap,
        pointSize: DEFAULT_POINT_SIZE,
        structureOpacity: 1
      }));
    }

    setFilterState({
      elevationMin: parsed.metadata.bounds.minZ,
      elevationMax: parsed.metadata.bounds.maxZ,
      intensityMin: parsed.metadata.intensityRange[0],
      intensityMax: parsed.metadata.intensityRange[1],
      enabledClasses: new Set(Object.keys(parsed.metadata.classCounts).map(Number)),
      cropBoxEnabled: false,
      cropBoxMin: [
        parsed.metadata.bounds.minX * 0.6,
        parsed.metadata.bounds.minY * 0.6,
        parsed.metadata.bounds.minZ
      ],
      cropBoxMax: [
        parsed.metadata.bounds.maxX * 0.6,
        parsed.metadata.bounds.maxY * 0.6,
        parsed.metadata.bounds.maxZ
      ],
      decimationRate: 1.0
    });
  };

  const handleImportFile = async (file: File) => {
    const filename = file.name.toLowerCase();
    if (filename.endsWith('.laz')) {
      toast.error('Compressed .laz is not supported yet. Export as .las and try again.');
      return;
    }
    try {
      let parsed;
      if (filename.endsWith('.las')) {
        parsed = parseLasFile(await file.arrayBuffer(), file.name);
      } else if (filename.endsWith('.ply')) {
        parsed = parsePlyFile(await file.arrayBuffer(), file.name);
      } else if (/\.(xyz|pts|csv|txt)$/.test(filename)) {
        parsed = parseXyzFile(await file.text(), file.name);
      } else {
        toast.error('Unsupported format. Use .e57, .las, .ply or .xyz files, or a databag folder.');
        return;
      }
      leaveStreamedCloud();
      setPoints(parsed.points);
      setMetadata(parsed.metadata);
      originalPointsRef.current = parsed.points;
      resetFilterStateForNewCloud(parsed.metadata);
      // Scan-specific point size and translucent walls don't suit an arbitrary import
      if (findScan(activePresetId)) {
        setRenderSettings(prev => ({ ...prev, pointSize: DEFAULT_POINT_SIZE, structureOpacity: 1 }));
      }
      setActivePresetId('');
      setLoadingScan(null);
      toast.success(`Loaded ${file.name}`, { description: `${parsed.metadata.pointCount.toLocaleString()} points` });
    } catch (err: any) {
      toast.error(`Could not read ${file.name}`, { description: String(err.message || err) });
    }
  };

  const resetFilterStateForNewCloud = (meta: LidarMetadata) => {
    setFilterState({
      elevationMin: meta.bounds.minZ,
      elevationMax: meta.bounds.maxZ,
      intensityMin: meta.intensityRange[0],
      intensityMax: meta.intensityRange[1],
      enabledClasses: new Set(Object.keys(meta.classCounts).map(Number)),
      cropBoxEnabled: false,
      cropBoxMin: [meta.bounds.minX * 0.6, meta.bounds.minY * 0.6, meta.bounds.minZ],
      cropBoxMax: [meta.bounds.maxX * 0.6, meta.bounds.maxY * 0.6, meta.bounds.maxZ],
      decimationRate: 1.0
    });
  };

  const handleApplyCropToPoints = () => {
    if (!filterState.cropBoxEnabled) return;
    const [minX, minY, minZ] = filterState.cropBoxMin;
    const [maxX, maxY, maxZ] = filterState.cropBoxMax;

    const cropped = points.filter(p =>
      p.x >= minX && p.x <= maxX &&
      p.y >= minY && p.y <= maxY &&
      p.z >= minZ && p.z <= maxZ
    );

    if (cropped.length === 0) {
      toast.error('No points inside the crop box.');
      return;
    }

    setPoints(cropped);
    setFilterState(prev => ({ ...prev, cropBoxEnabled: false }));
  };

  const handleRemoveOutliers = () => {
    if (points.length < 50) return;

    let sumZ = 0;
    points.forEach(p => { sumZ += p.z; });
    const meanZ = sumZ / points.length;

    let sumSqDiff = 0;
    points.forEach(p => { sumSqDiff += (p.z - meanZ) ** 2; });
    const stdDevZ = Math.sqrt(sumSqDiff / points.length);

    const cleaned = points.filter(p => {
      const isNoiseClass = p.classification === 7 || p.classification === 18;
      const isExtremeZ = Math.abs(p.z - meanZ) > stdDevZ * 2.8;
      return !isNoiseClass && !isExtremeZ;
    });

    setPoints(cleaned);
  };

  /**
   * Delete one physical object rather than a whole class: cluster the points the user can currently
   * see, pick the one they asked for, and drop it. Reset restores it.
   */
  const handleRemoveObject = (params: Record<string, any>) => {
    const classes: number[] | undefined = Array.isArray(params.classes)
      ? params.classes
      : typeof params.class === 'number'
        ? [params.class]
        : filterState.enabledClasses.size > 0
          ? Array.from(filterState.enabledClasses)
          : undefined;

    const clusters = clusterPoints(points, { classes });
    if (!clusters.length) {
      toast.error('Nothing to remove', { description: 'No separate objects found in the visible points.' });
      return;
    }

    const howMany = Math.max(1, Math.min(Number(params.count) || 1, clusters.length));
    const target = params.index !== undefined ? Number(params.index) : (params.which ?? 'largest');

    const doomed = new Set<number>();
    const removed: string[] = [];
    const remaining = [...clusters];
    for (let n = 0; n < howMany; n++) {
      const cluster = pickCluster(remaining, n === 0 ? target : 'largest');
      if (!cluster) break;
      cluster.indices.forEach(i => doomed.add(i));
      removed.push(describeCluster(cluster, clusters.indexOf(cluster)));
      remaining.splice(remaining.indexOf(cluster), 1);
    }
    if (!doomed.size) return;

    setPoints(points.filter((_, i) => !doomed.has(i)));
    toast.success(`Removed ${removed.length} object${removed.length > 1 ? 's' : ''}`, {
      description: `${doomed.size.toLocaleString()} points · ${removed[0]} · Reset restores it.`
    });
  };

  const handleResetFilters = () => {
    setPoints(originalPointsRef.current);
    resetFilterStateForNewCloud(metadata);
  };

  const handleExport = (format: 'las' | 'ply' | 'xyz') => {
    // Streamed scans live on the server; hand out the full-resolution E57
    if (streamed) {
      window.open(sourceE57Url(streamed.cloud), '_blank');
      return;
    }
    const {
      elevationMin, elevationMax,
      intensityMin, intensityMax,
      enabledClasses,
      cropBoxEnabled, cropBoxMin, cropBoxMax
    } = filterState;

    const visiblePoints = points.filter(p => {
      if (p.z < elevationMin || p.z > elevationMax) return false;
      const intens = p.intensity ?? 0;
      if (intens < intensityMin || intens > intensityMax) return false;
      const cls = p.classification ?? 1;
      if (enabledClasses.size > 0 && !enabledClasses.has(cls)) return false;
      if (cropBoxEnabled) {
        if (
          p.x < cropBoxMin[0] || p.x > cropBoxMax[0] ||
          p.y < cropBoxMin[1] || p.y > cropBoxMax[1] ||
          p.z < cropBoxMin[2] || p.z > cropBoxMax[2]
        ) {
          return false;
        }
      }
      return true;
    });

    let blob: Blob;
    let filename = `lidar_export_${Date.now()}.${format}`;

    if (format === 'las') {
      blob = exportToLas(visiblePoints, metadata.bounds);
    } else if (format === 'ply') {
      blob = exportToPly(visiblePoints);
    } else {
      blob = exportToXyz(visiblePoints);
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExecuteAgentAction = (action: AgentAction) => {
    switch (action.type) {
      case 'strip_ground':
        {
          const next = new Set(Object.keys(metadata.classCounts).map(Number));
          next.delete(2);
          setFilterState(prev => ({ ...prev, enabledClasses: next }));
        }
        break;

      case 'isolate_ground':
        setFilterState(prev => ({ ...prev, enabledClasses: new Set([2]) }));
        break;

      case 'isolate_buildings':
        setFilterState(prev => ({ ...prev, enabledClasses: new Set([6]) }));
        break;

      case 'isolate_vegetation':
        setFilterState(prev => ({ ...prev, enabledClasses: new Set([3, 4, 5]) }));
        break;

      case 'filter_classification':
        if (action.parameters?.enabledClasses) {
          setFilterState(prev => ({
            ...prev,
            enabledClasses: new Set(action.parameters.enabledClasses)
          }));
        }
        break;

      case 'crop_elevation':
        if (action.parameters) {
          setFilterState(prev => ({
            ...prev,
            elevationMin: action.parameters.minZ ?? prev.elevationMin,
            elevationMax: action.parameters.maxZ ?? prev.elevationMax
          }));
        }
        break;

      case 'crop_roi':
        if (action.parameters) {
          const p = action.parameters;
          setFilterState(prev => ({
            ...prev,
            cropBoxEnabled: true,
            cropBoxMin: [p.minX ?? prev.cropBoxMin[0], p.minY ?? prev.cropBoxMin[1], p.minZ ?? prev.cropBoxMin[2]],
            cropBoxMax: [p.maxX ?? prev.cropBoxMax[0], p.maxY ?? prev.cropBoxMax[1], p.maxZ ?? prev.cropBoxMax[2]]
          }));
        }
        break;

      case 'set_color_mode':
        if (action.parameters) {
          setRenderSettings(prev => ({
            ...prev,
            colorMode: action.parameters.mode || prev.colorMode,
            colormap: action.parameters.colormap || prev.colormap
          }));
        }
        break;

      case 'decimate':
        if (action.parameters?.rate) {
          setFilterState(prev => ({ ...prev, decimationRate: action.parameters.rate }));
        }
        break;

      case 'remove_outliers':
        handleRemoveOutliers();
        break;

      case 'reset_filters':
        handleResetFilters();
        break;

      case 'load_dataset':
        if (action.parameters?.presetId) {
          handleLoadPreset(action.parameters.presetId);
        }
        break;

      case 'remove_object':
        handleRemoveObject(action.parameters ?? {});
        break;

      case 'export_cloud':
        handleExport((action.parameters?.format as any) || 'las');
        break;
    }
  };

  const controls = (
    <LidarControlsPanel
      metadata={metadata}
      filterState={filterState}
      onUpdateFilter={up => setFilterState(prev => ({ ...prev, ...up }))}
      renderSettings={renderSettings}
      onUpdateRenderSettings={up => setRenderSettings(prev => ({ ...prev, ...up }))}
      onApplyCropToPoints={handleApplyCropToPoints}
      onRemoveOutliers={handleRemoveOutliers}
      onResetFilters={handleResetFilters}
    />
  );

  const chat = (
    <Tabs
      value={rightPane}
      onValueChange={v => {
        const pane = v as 'agent' | 'photoreal';
        setRightPane(pane);
        if (pane === 'photoreal' && photoreal.shots.length > 0) photoreal.setStageOpen(true);
      }}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <div className="border-b px-3 py-2.5">
        <TabsList className="w-full">
          <TabsTrigger value="agent">Agent</TabsTrigger>
          <TabsTrigger value="photoreal">Photoreal</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="agent" forceMount className="min-h-0 flex-1 data-[state=inactive]:hidden">
        <LidarAgentChat
          metadata={metadata}
          filterState={filterState}
          renderSettings={renderSettings}
          onExecuteAgentAction={handleExecuteAgentAction}
        />
      </TabsContent>
      <TabsContent value="photoreal" forceMount className="min-h-0 flex-1 data-[state=inactive]:hidden">
        <PhotorealStudio photoreal={photoreal} />
      </TabsContent>
    </Tabs>
  );

  return (
    <div className="dark flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Sheet open={controlsOpen} onOpenChange={setControlsOpen}>
          <SheetTrigger asChild>
            <Button size="icon-sm" variant="ghost" className="lg:hidden" aria-label="Open layers">
              <SlidersHorizontal />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="dark w-[88vw] max-w-sm gap-0 p-0 text-foreground">
            <SheetHeader className="sr-only">
              <SheetTitle>Layers</SheetTitle>
            </SheetHeader>
            {controls}
          </SheetContent>
        </Sheet>

        <div className="flex items-center gap-2 pr-1">
          <img src="/favicon.svg" alt="" className="size-6" />
          <span className="hidden text-sm font-semibold tracking-tight sm:inline">Mimaar</span>
        </div>

        <Select value={activePresetId} onValueChange={handleLoadPreset}>
          <SelectTrigger size="sm" className="w-auto max-w-[46vw] min-w-0 border-transparent bg-transparent dark:bg-transparent sm:max-w-xs">
            <SelectValue placeholder={metadata.filename} />
          </SelectTrigger>
          <SelectContent className="dark">
            {SCAN_DATASETS.map(s => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
            {SAMPLE_PRESETS.map(p => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
            {uploadedClouds.some(c => c.status === 'ready') && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel>Uploaded scans</SelectLabel>
                  {uploadedClouds
                    .filter(c => c.status === 'ready')
                    .map(c => (
                      <SelectItem key={c.id} value={`cloud:${c.id}`}>
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectGroup>
              </>
            )}
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept=".e57,.las,.ply,.xyz,.pts,.csv,.txt"
            className="hidden"
            onChange={e => {
              if (e.target.files?.length) handleImportFiles(Array.from(e.target.files));
              e.target.value = '';
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error non-standard attribute for folder picking
            webkitdirectory=""
            className="hidden"
            onChange={e => {
              if (e.target.files?.length) handleImportFiles(Array.from(e.target.files));
              e.target.value = '';
            }}
          />
          <Button size="sm" variant="ghost" onClick={() => fileInputRef.current?.click()}>
            <Upload />
            <span className="hidden sm:inline">Import</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => folderInputRef.current?.click()}
            title="Upload a databag folder (data_N.bag + calibration.yaml)"
          >
            <FolderUp />
            <span className="hidden sm:inline">Databag</span>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary">
                <Download />
                <span className="hidden sm:inline">Export</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="dark">
              {streamed ? (
                <DropdownMenuItem onClick={() => handleExport('las')}>Full scan (.e57)</DropdownMenuItem>
              ) : (
                <>
                  <DropdownMenuItem onClick={() => handleExport('las')}>LAS (.las)</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport('ply')}>PLY (.ply)</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport('xyz')}>XYZ text (.xyz)</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Sheet open={chatOpen} onOpenChange={setChatOpen}>
            <SheetTrigger asChild>
              <Button size="sm" className="xl:hidden" aria-label="Open agent">
                <Sparkles />
                <span className="hidden sm:inline">Agent</span>
              </Button>
            </SheetTrigger>
            <SheetContent
              side={isPhone ? 'bottom' : 'right'}
              showCloseButton={false}
              className={
                isPhone
                  ? 'dark gap-0 rounded-t-xl p-0 text-foreground data-[side=bottom]:h-[75dvh]'
                  : 'dark w-96 gap-0 p-0 text-foreground sm:max-w-96'
              }
            >
              <SheetHeader className="sr-only">
                <SheetTitle>Agent</SheetTitle>
              </SheetHeader>
              {chat}
            </SheetContent>
          </Sheet>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-72 shrink-0 border-r bg-sidebar lg:block">{controls}</aside>

        <main
          className="relative min-w-0 flex-1"
          onDragOver={e => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={e => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files?.length) handleImportFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {streamed ? (
            <OctreeViewport
              hierarchy={streamed.hierarchy}
              binUrl={octreeUrl(streamed.cloud)}
              metadata={metadata}
              filterState={filterState}
              renderSettings={renderSettings}
              editingMode={editingMode}
              onChangeEditingMode={setEditingMode}
              captureRef={captureRef}
            />
          ) : (
            <LidarViewport
              points={points}
              metadata={metadata}
              filterState={filterState}
              renderSettings={renderSettings}
              editingMode={editingMode}
              onChangeEditingMode={setEditingMode}
              captureRef={captureRef}
              startInside={!!findScan(activePresetId)?.startInside}
            />
          )}
          {importStatus && (
            <div className="absolute bottom-14 left-1/2 z-30 w-80 max-w-[calc(100%-1.5rem)] -translate-x-1/2 rounded-lg border bg-background/90 px-3 py-2.5 text-xs shadow-sm backdrop-blur-md">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{importStatus.label}</span>
                {importStatus.error && (
                  <Button size="icon-xs" variant="ghost" onClick={() => setImportStatus(null)} aria-label="Dismiss">
                    <X />
                  </Button>
                )}
              </div>
              {importStatus.error ? (
                <div className="mt-1 text-destructive">{importStatus.error}</div>
              ) : importStatus.progress ? (
                <>
                  <div className="mt-1.5 flex justify-between text-muted-foreground">
                    <span>
                      {importStatus.progress.phase === 'uploading'
                        ? 'Uploading'
                        : importStatus.progress.phase === 'queued'
                          ? 'Waiting to process'
                          : 'Processing on server'}
                    </span>
                    <span className="font-mono tabular-nums">{Math.round(importStatus.progress.fraction * 100)}%</span>
                  </div>
                  {importStatus.progress.detail && (
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{importStatus.progress.detail}</div>
                  )}
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary transition-all" style={{ width: `${importStatus.progress.fraction * 100}%` }} />
                  </div>
                </>
              ) : (
                <div className="mt-1 text-muted-foreground">Preparing point cloud…</div>
              )}
            </div>
          )}
          {loadingScan && (
            <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading {loadingScan}
            </div>
          )}
          <PhotorealStage photoreal={photoreal} />
          {isDragging && (
            <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary">
              Drop an .e57, .las, .ply or .xyz file, or databag files
            </div>
          )}
        </main>

        <aside className="hidden w-[360px] shrink-0 border-l bg-sidebar xl:block">{chat}</aside>
      </div>
      <Toaster position="top-center" />
    </div>
  );
}
