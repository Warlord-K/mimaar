import React from 'react';
import {
  LidarMetadata,
  LidarFilterState,
  LidarRenderSettings,
  LidarColorMode,
  ColormapType
} from '../types/lidar';
import { getClassificationColor, getClassificationName } from '../utils/colormaps';
import { Eye, EyeOff, RotateCcw, Scissors, Sparkles } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface LidarControlsPanelProps {
  metadata: LidarMetadata;
  filterState: LidarFilterState;
  onUpdateFilter: (filter: Partial<LidarFilterState>) => void;
  renderSettings: LidarRenderSettings;
  onUpdateRenderSettings: (settings: Partial<LidarRenderSettings>) => void;
  onApplyCropToPoints: () => void;
  onRemoveOutliers: () => void;
  onResetFilters: () => void;
}

const COLOR_MODES: { id: LidarColorMode; label: string }[] = [
  { id: 'classification', label: 'Classification' },
  { id: 'elevation', label: 'Elevation' },
  { id: 'intensity', label: 'Intensity' },
  { id: 'rgb', label: 'True color (RGB)' },
  { id: 'returns', label: 'Return number' }
];

const COLORMAPS: ColormapType[] = ['viridis', 'turbo', 'terrain', 'rainbow', 'plasma', 'spectral'];

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export const LidarControlsPanel: React.FC<LidarControlsPanelProps> = ({
  metadata,
  filterState,
  onUpdateFilter,
  renderSettings,
  onUpdateRenderSettings,
  onApplyCropToPoints,
  onRemoveOutliers,
  onResetFilters
}) => {
  const allClasses = Object.keys(metadata.classCounts).map(Number);

  const toggleClass = (code: number) => {
    const next = new Set(filterState.enabledClasses);
    next.has(code) ? next.delete(code) : next.add(code);
    onUpdateFilter({ enabledClasses: next });
  };

  const presets: { label: string; classes: number[] }[] = [
    { label: 'All', classes: allClasses },
    { label: 'Ground', classes: [2] },
    { label: 'No ground', classes: allClasses.filter(c => c !== 2) },
    { label: 'Buildings', classes: [6] },
    { label: 'Vegetation', classes: [3, 4, 5] }
  ];

  const zStep = Math.max(0.1, metadata.bounds.sizeZ / 200);

  return (
    <Tabs defaultValue="classes" className="flex h-full min-h-0 flex-col gap-0">
      <div className="border-b px-3 py-2.5">
        <TabsList className="w-full">
          <TabsTrigger value="classes">Classes</TabsTrigger>
          <TabsTrigger value="edit">Edit</TabsTrigger>
          <TabsTrigger value="view">View</TabsTrigger>
        </TabsList>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          <TabsContent value="classes" className="space-y-5">
            <Section title="Quick filters">
              <div className="flex flex-wrap gap-1.5">
                {presets.map(p => (
                  <Button
                    key={p.label}
                    size="xs"
                    variant="outline"
                    onClick={() => onUpdateFilter({ enabledClasses: new Set(p.classes) })}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
            </Section>

            <Section
              title="Point classes"
              aside={
                <span className="font-mono text-[11px] text-muted-foreground">
                  {filterState.enabledClasses.size}/{allClasses.length}
                </span>
              }
            >
              <div className="-mx-1 space-y-0.5">
                {allClasses.map(code => {
                  const enabled = filterState.enabledClasses.has(code);
                  const color = getClassificationColor(code);
                  return (
                    <button
                      key={code}
                      onClick={() => toggleClass(code)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60',
                        !enabled && 'opacity-45'
                      )}
                    >
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: `rgb(${color.join(',')})` }}
                      />
                      <span className="flex-1 truncate">{getClassificationName(code)}</span>
                      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                        {metadata.classCounts[code].toLocaleString()}
                      </span>
                      {enabled ? (
                        <Eye className="size-3.5 text-muted-foreground" />
                      ) : (
                        <EyeOff className="size-3.5 text-muted-foreground" />
                      )}
                    </button>
                  );
                })}
              </div>
            </Section>
          </TabsContent>

          <TabsContent value="edit" className="space-y-6">
            <Section
              title="Elevation slice"
              aside={
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {filterState.elevationMin.toFixed(1)} to {filterState.elevationMax.toFixed(1)} m
                </span>
              }
            >
              <Slider
                min={metadata.bounds.minZ}
                max={metadata.bounds.maxZ}
                step={zStep}
                value={[filterState.elevationMin, filterState.elevationMax]}
                onValueChange={([min, max]) => onUpdateFilter({ elevationMin: min, elevationMax: max })}
              />
            </Section>

            <Section
              title="Box crop"
              aside={
                <Switch
                  checked={filterState.cropBoxEnabled}
                  onCheckedChange={checked => onUpdateFilter({ cropBoxEnabled: checked })}
                />
              }
            >
              {filterState.cropBoxEnabled ? (
                <Button size="sm" variant="secondary" className="w-full" onClick={onApplyCropToPoints}>
                  <Scissors />
                  Delete points outside box
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">Clip the cloud to a region of interest.</p>
              )}
            </Section>

            <Section title="Density">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                className="w-full"
                value={String(filterState.decimationRate)}
                onValueChange={v => v && onUpdateFilter({ decimationRate: Number(v) })}
              >
                {[1, 0.5, 0.25, 0.1].map(rate => (
                  <ToggleGroupItem key={rate} value={String(rate)} className="flex-1 font-mono text-xs">
                    {rate * 100}%
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Section>

            <div className="flex flex-col gap-2">
              <Button size="sm" variant="secondary" onClick={onRemoveOutliers}>
                <Sparkles />
                Remove noise
              </Button>
              <Button size="sm" variant="ghost" onClick={onResetFilters}>
                <RotateCcw />
                Reset all edits
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="view" className="space-y-6">
            <Section title="Color by">
              <Select
                value={renderSettings.colorMode}
                onValueChange={v => onUpdateRenderSettings({ colorMode: v as LidarColorMode })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COLOR_MODES.map(m => (
                    <SelectItem key={m.id} value={m.id} disabled={m.id === 'rgb' && !metadata.hasRGB}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Section>

            {renderSettings.colorMode === 'elevation' && (
              <Section title="Colormap">
                <Select
                  value={renderSettings.colormap}
                  onValueChange={v => onUpdateRenderSettings({ colormap: v as ColormapType })}
                >
                  <SelectTrigger className="w-full capitalize">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COLORMAPS.map(c => (
                      <SelectItem key={c} value={c} className="capitalize">
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Section>
            )}

            <Section
              title="Point size"
              aside={
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {renderSettings.pointSize.toFixed(1)}
                </span>
              }
            >
              <Slider
                min={0.1}
                max={4}
                step={0.1}
                value={[renderSettings.pointSize]}
                onValueChange={([v]) => onUpdateRenderSettings({ pointSize: v })}
              />
            </Section>

            {metadata.format === 'E57' ? (
              // Streamed scans size points adaptively; EDL shades depth instead
              <Section
                title="Eye-dome lighting"
                aside={
                  <Switch
                    checked={renderSettings.edlEnabled}
                    onCheckedChange={checked => onUpdateRenderSettings({ edlEnabled: checked })}
                  />
                }
              >
                {renderSettings.edlEnabled && (
                  <Slider
                    min={0.1}
                    max={2}
                    step={0.1}
                    value={[renderSettings.edlStrength]}
                    onValueChange={([v]) => onUpdateRenderSettings({ edlStrength: v })}
                  />
                )}
              </Section>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Scale with distance</span>
                <Switch
                  checked={renderSettings.sizeAttenuation}
                  onCheckedChange={checked => onUpdateRenderSettings({ sizeAttenuation: checked })}
                />
              </div>
            )}
          </TabsContent>
        </div>
      </ScrollArea>
    </Tabs>
  );
};
