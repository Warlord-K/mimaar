import { useState, useRef, useSyncExternalStore } from 'react';
import {
  LidarPoint,
  LidarMetadata,
  LidarFilterState,
  LidarRenderSettings,
  EditingMode,
  AgentAction
} from './types/lidar';
import { generateSampleDataset, SAMPLE_PRESETS } from './data/sampleLidar';
import {
  parseLasFile,
  parsePlyFile,
  parseXyzFile,
  exportToLas,
  exportToPly,
  exportToXyz
} from './utils/lidarParser';
import { LidarViewport } from './components/LidarViewport';
import { LidarControlsPanel } from './components/LidarControlsPanel';
import { LidarAgentChat } from './components/LidarAgentChat';
import { PhotorealStudio } from './components/PhotorealStudio';
import { ViewportCaptureFn } from './types/photoreal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Download, SlidersHorizontal, Sparkles, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

const PHONE_QUERY = '(max-width: 639px)';

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
  const [activePresetId, setActivePresetId] = useState<string>('urban_aerial');
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
    pointSize: 0.5,
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
  const [rightPane, setRightPane] = useState<'agent' | 'photoreal'>('agent');
  const captureRef = useRef<ViewportCaptureFn | null>(null);
  const photorealSceneHint =
    metadata.format === 'SYNTHETIC' ? SAMPLE_PRESETS.find(p => p.id === activePresetId)?.description ?? '' : '';

  const handleLoadPreset = (presetId: string) => {
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
        colormap: presetConfig.recommendedColormap
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
        toast.error('Unsupported format. Use .las, .ply or .xyz files.');
        return;
      }
      setPoints(parsed.points);
      setMetadata(parsed.metadata);
      originalPointsRef.current = parsed.points;
      resetFilterStateForNewCloud(parsed.metadata);
      setActivePresetId('');
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

  const handleResetFilters = () => {
    setPoints(originalPointsRef.current);
    resetFilterStateForNewCloud(metadata);
  };

  const handleExport = (format: 'las' | 'ply' | 'xyz') => {
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
      onValueChange={v => setRightPane(v as 'agent' | 'photoreal')}
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
        <PhotorealStudio
          captureRef={captureRef}
          metadata={metadata}
          filterState={filterState}
          renderSettings={renderSettings}
          defaultScene={photorealSceneHint}
        />
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
            {SAMPLE_PRESETS.map(p => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept=".las,.ply,.xyz,.pts,.csv,.txt"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) handleImportFile(file);
              e.target.value = '';
            }}
          />
          <Button size="sm" variant="ghost" onClick={() => fileInputRef.current?.click()}>
            <Upload />
            <span className="hidden sm:inline">Import</span>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary">
                <Download />
                <span className="hidden sm:inline">Export</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="dark">
              <DropdownMenuItem onClick={() => handleExport('las')}>LAS (.las)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('ply')}>PLY (.ply)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('xyz')}>XYZ text (.xyz)</DropdownMenuItem>
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
                  ? 'dark h-[75dvh] gap-0 rounded-t-xl p-0 text-foreground'
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
            const file = e.dataTransfer.files?.[0];
            if (file) handleImportFile(file);
          }}
        >
          <LidarViewport
            points={points}
            metadata={metadata}
            filterState={filterState}
            renderSettings={renderSettings}
            editingMode={editingMode}
            onChangeEditingMode={setEditingMode}
            captureRef={captureRef}
          />
          {isDragging && (
            <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary">
              Drop a .las, .ply or .xyz file
            </div>
          )}
        </main>

        <aside className="hidden w-[360px] shrink-0 border-l bg-sidebar xl:block">{chat}</aside>
      </div>
      <Toaster position="top-center" />
    </div>
  );
}
