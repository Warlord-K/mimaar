import React, { useState, useRef, useEffect } from 'react';
import {
  ChatMessage,
  AgentAction,
  LidarMetadata,
  LidarFilterState,
  LidarRenderSettings
} from '../types/lidar';
import {
  Sparkles,
  Send,
  Bot,
  User,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  Zap,
  ArrowRight,
  RefreshCw,
  Sliders,
  Terminal,
  Trash2
} from 'lucide-react';

interface LidarAgentChatProps {
  metadata: LidarMetadata;
  filterState: LidarFilterState;
  renderSettings: LidarRenderSettings;
  onExecuteAgentAction: (action: AgentAction) => void;
  onResetFilters: () => void;
}

const QUICK_PROMPTS = [
  '🌱 Strip ground points to analyze canopy structure',
  '🏢 Isolate all buildings and color by height',
  '🌈 Switch to Turbo colormap colored by elevation',
  '🧹 Clean airborne noise outliers from the scan',
  '📊 What are the point density and elevation bounds?',
  '⚡ Decimate point cloud to 50% for high performance'
];

export const LidarAgentChat: React.FC<LidarAgentChatProps> = ({
  metadata,
  filterState,
  renderSettings,
  onExecuteAgentAction,
  onResetFilters
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      sender: 'assistant',
      content: `Hello! I am your **LiDAR Agentic Copilot**. I can inspect point cloud geometry, filter ASPRS classifications (ground, canopy, buildings), crop elevation slices, clean laser noise, adjust colormaps, and calculate survey statistics.\n\nTry giving an instruction or click one of the quick actions below!`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      suggestedPrompts: [
        'Strip ground to inspect canopy',
        'Isolate buildings only',
        'Color by elevation with terrain colormap'
      ]
    }
  ]);

  const [inputPrompt, setInputPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSendMessage = async (textToSend?: string) => {
    const prompt = (textToSend || inputPrompt).trim();
    if (!prompt || isLoading) return;

    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      sender: 'user',
      content: prompt,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setMessages(prev => [...prev, userMsg]);
    setInputPrompt('');
    setIsLoading(true);

    try {
      // Internal API Contract to LLM Agent Endpoint
      const sceneSummary = {
        filename: metadata.filename,
        format: metadata.format,
        pointCount: metadata.pointCount,
        densityPerSqMeter: metadata.densityPerSqMeter,
        elevationRange: [metadata.bounds.minZ, metadata.bounds.maxZ],
        bounds: metadata.bounds,
        activeClasses: Array.from(filterState.enabledClasses),
        colorMode: renderSettings.colorMode,
        colormap: renderSettings.colormap,
        decimationRate: filterState.decimationRate,
        cropBoxEnabled: filterState.cropBoxEnabled
      };

      const response = await fetch('/api/v1/agent/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-requested-by': 'blender-web-client'
        },
        body: JSON.stringify({
          message: prompt,
          history: messages.slice(-6).map(m => ({ role: m.sender, content: m.content })),
          sceneSummary
        })
      });

      if (!response.ok) {
        throw new Error(`Server returned status ${response.status}`);
      }

      const data = await response.json();

      const assistantMsg: ChatMessage = {
        id: `assistant_${Date.now()}`,
        sender: 'assistant',
        content: data.reply || 'Action executed successfully.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        actionsExecuted: data.actions || [],
        suggestedPrompts: data.suggestedFollowUps || []
      };

      setMessages(prev => [...prev, assistantMsg]);

      // Automatically execute actions returned by the LLM
      if (data.actions && Array.isArray(data.actions)) {
        data.actions.forEach((act: AgentAction) => {
          onExecuteAgentAction(act);
        });
      }
    } catch (err: any) {
      console.error('Agent chat error:', err);
      // Fallback local agent rule-based interpreter in case of API failure or missing keys
      const fallbackResult = handleLocalAgentFallback(prompt, metadata, filterState);

      const assistantMsg: ChatMessage = {
        id: `assistant_${Date.now()}`,
        sender: 'assistant',
        content: fallbackResult.reply,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        actionsExecuted: fallbackResult.actions,
        suggestedPrompts: ['Color by elevation', 'Isolate ground only', 'Reset filters']
      };

      setMessages(prev => [...prev, assistantMsg]);

      fallbackResult.actions.forEach(act => onExecuteAgentAction(act));
    } finally {
      setIsLoading(false);
    }
  };

  // Rule-based fallback if external API is temporarily unavailable
  const handleLocalAgentFallback = (
    prompt: string,
    meta: LidarMetadata,
    filter: LidarFilterState
  ): { reply: string; actions: AgentAction[] } => {
    const lower = prompt.toLowerCase();
    const actions: AgentAction[] = [];
    let reply = '';

    if (lower.includes('strip ground') || lower.includes('remove ground') || lower.includes('canopy')) {
      actions.push({
        id: `act_${Date.now()}`,
        type: 'strip_ground',
        label: 'Strip Ground Points',
        parameters: {},
        explanation: 'Ground points (Class 2) filtered out to reveal canopy and structures.'
      });
      reply = `Ground points have been removed from the view to isolate canopy and structural features. Only vegetation and structures are now visible.`;
    } else if (lower.includes('building')) {
      actions.push({
        id: `act_${Date.now()}`,
        type: 'isolate_buildings',
        label: 'Isolate Buildings',
        parameters: {},
        explanation: 'Filtering all points except Building Classification (Class 6).'
      });
      reply = `Filtering scan to show exclusively building structural returns (Class 6).`;
    } else if (lower.includes('ground only') || lower.includes('dtm')) {
      actions.push({
        id: `act_${Date.now()}`,
        type: 'isolate_ground',
        label: 'Isolate Ground (DTM)',
        parameters: {},
        explanation: 'Keeping only Ground Classification (Class 2) for Digital Terrain Model.'
      });
      reply = `Bare-earth Digital Terrain Model (DTM) mode activated. Showing ground points only.`;
    } else if (lower.includes('noise') || lower.includes('outlier') || lower.includes('clean')) {
      actions.push({
        id: `act_${Date.now()}`,
        type: 'remove_outliers',
        label: 'Statistical Outlier Removal (SOR)',
        parameters: {},
        explanation: 'Removing airborne noise and stray isolated laser pulses.'
      });
      reply = `Applying Statistical Outlier Filter to purge floating airborne noise from the cloud.`;
    } else if (lower.includes('density') || lower.includes('count') || lower.includes('stat') || lower.includes('bound')) {
      reply = `Here are the scan survey metrics:\n- **Total Points:** ${meta.pointCount.toLocaleString()} pts\n- **Point Density:** ${meta.densityPerSqMeter} pts/m²\n- **Elevation Range (Z):** ${meta.bounds.minZ.toFixed(2)}m to ${meta.bounds.maxZ.toFixed(2)}m (ΔZ = ${meta.bounds.sizeZ.toFixed(2)}m)\n- **Spatial Area:** ${meta.bounds.sizeX.toFixed(1)}m × ${meta.bounds.sizeY.toFixed(1)}m (~${Math.round(meta.bounds.sizeX * meta.bounds.sizeY).toLocaleString()} m²)`;
    } else if (lower.includes('turbo') || lower.includes('viridis') || lower.includes('terrain') || lower.includes('elevation') || lower.includes('color')) {
      let cmap = 'viridis';
      if (lower.includes('turbo')) cmap = 'turbo';
      else if (lower.includes('terrain')) cmap = 'terrain';
      else if (lower.includes('plasma')) cmap = 'plasma';

      actions.push({
        id: `act_${Date.now()}`,
        type: 'set_color_mode',
        label: `Set Colormap to ${cmap.toUpperCase()}`,
        parameters: { mode: 'elevation', colormap: cmap },
        explanation: `Updated viewport coloring to elevation gradient with colormap '${cmap}'.`
      });
      reply = `Switched shading to elevation with the ${cmap.toUpperCase()} scientific colormap.`;
    } else if (lower.includes('reset')) {
      actions.push({
        id: `act_${Date.now()}`,
        type: 'reset_filters',
        label: 'Reset All Filters',
        parameters: {},
        explanation: 'Resetting all classification and elevation filters to default.'
      });
      reply = `All filters, elevation slices, and ROI bounds have been reset. Full point cloud restored.`;
    } else if (lower.includes('decimate') || lower.includes('50%')) {
      actions.push({
        id: `act_${Date.now()}`,
        type: 'decimate',
        label: 'Decimate to 50%',
        parameters: { factor: 0.5 },
        explanation: 'Downsampling point cloud density to 50% for accelerated rendering.'
      });
      reply = `Point cloud decimated to 50% density.`;
    } else {
      reply = `I can help you filter this scan. Try asking to:
- "Strip ground points to analyze canopy"
- "Isolate buildings"
- "Color by elevation with Turbo colormap"
- "Clean laser noise outliers"
- "What are the scan metrics?"`;
    }

    return { reply, actions };
  };

  return (
    <div className="flex flex-col h-full bg-[#181922] border-l border-[#2d3040] text-gray-200 select-none overflow-hidden">
      {/* Agent Header */}
      <div className="p-3 bg-[#1e202b] border-b border-[#2d313e] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-[#e87d0d]/15 text-[#e87d0d] rounded-lg">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-gray-100">LiDAR Agentic Copilot</span>
              <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-1.5 py-0.2 rounded border border-emerald-500/20">
                gemini-3.8-flash
              </span>
            </div>
            <div className="text-[10px] text-gray-400">Natural language 3D point cloud actions</div>
          </div>
        </div>

        <button
          onClick={() => {
            setMessages([
              {
                id: 'welcome_reset',
                sender: 'assistant',
                content: 'Chat history cleared. How can I help analyze or edit your LiDAR data?',
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              }
            ]);
          }}
          title="Clear Chat History"
          className="text-gray-500 hover:text-gray-300 p-1 rounded"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
        {messages.map(msg => (
          <div
            key={msg.id}
            className={`flex flex-col ${
              msg.sender === 'user' ? 'items-end' : 'items-start'
            } space-y-1.5`}
          >
            <div className="flex items-center gap-1.5 text-[10px] text-gray-500 font-mono px-1">
              {msg.sender === 'user' ? (
                <>
                  <span>You</span>
                  <span>·</span>
                  <span>{msg.timestamp}</span>
                </>
              ) : (
                <>
                  <Bot className="w-3 h-3 text-[#e87d0d]" />
                  <span>LiDAR Agent</span>
                  <span>·</span>
                  <span>{msg.timestamp}</span>
                </>
              )}
            </div>

            <div
              className={`p-3 rounded-xl max-w-[92%] leading-relaxed text-xs shadow-md select-text ${
                msg.sender === 'user'
                  ? 'bg-[#3b82f6] text-white rounded-tr-none'
                  : 'bg-[#222433] text-gray-200 border border-[#313548] rounded-tl-none'
              }`}
            >
              <div className="whitespace-pre-wrap">{msg.content}</div>

              {/* Action Badges Executed by Agent */}
              {msg.actionsExecuted && msg.actionsExecuted.length > 0 && (
                <div className="mt-2.5 pt-2 border-t border-[#373b50] space-y-1.5 font-sans">
                  <div className="text-[10px] font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1">
                    <Zap className="w-3 h-3" />
                    <span>Agent Actions Triggered:</span>
                  </div>
                  {msg.actionsExecuted.map(act => (
                    <div
                      key={act.id}
                      className="bg-[#181a24] border border-[#3c4158] rounded p-1.5 text-[11px] text-emerald-400 flex items-start gap-1.5"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold text-gray-200">{act.label}</div>
                        <div className="text-[10px] text-gray-400">{act.explanation}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Suggested Follow-up Prompts */}
            {msg.suggestedPrompts && msg.suggestedPrompts.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1 pl-1">
                {msg.suggestedPrompts.map((sug, sIdx) => (
                  <button
                    key={sIdx}
                    onClick={() => handleSendMessage(sug)}
                    className="text-[10px] bg-[#222431] hover:bg-[#2c2f42] text-amber-300 border border-amber-500/20 px-2 py-0.5 rounded transition-colors flex items-center gap-1"
                  >
                    <span>{sug}</span>
                    <ArrowRight className="w-2.5 h-2.5 opacity-60" />
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        {isLoading && (
          <div className="flex items-center gap-2 p-3 bg-[#222433] border border-[#313548] rounded-xl text-xs text-gray-300 w-fit">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#e87d0d]" />
            <span>Analyzing LiDAR geometry and executing actions...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Quick Action Inspiration Chips */}
      <div className="px-3 py-1.5 bg-[#1a1c26] border-t border-[#2d3040] overflow-x-auto whitespace-nowrap scrollbar-none flex gap-1.5 shrink-0">
        {QUICK_PROMPTS.map((qp, qIdx) => (
          <button
            key={qIdx}
            onClick={() => handleSendMessage(qp)}
            className="text-[10px] bg-[#242735] hover:bg-[#2f3346] text-gray-300 px-2 py-1 rounded border border-[#33374b] shrink-0 transition-colors"
          >
            {qp}
          </button>
        ))}
      </div>

      {/* Input Box */}
      <div className="p-3 bg-[#1e202b] border-t border-[#2d313e] shrink-0">
        <form
          onSubmit={e => {
            e.preventDefault();
            handleSendMessage();
          }}
          className="flex items-center gap-1.5"
        >
          <input
            type="text"
            value={inputPrompt}
            onChange={e => setInputPrompt(e.target.value)}
            placeholder="Instruct agent (e.g. 'strip ground', 'color by height')..."
            className="flex-1 bg-[#13141c] border border-[#34384d] rounded-lg px-3 py-2 text-xs text-gray-200 outline-none placeholder-gray-500 focus:border-[#e87d0d]"
          />
          <button
            type="submit"
            disabled={!inputPrompt.trim() || isLoading}
            className="p-2 bg-[#e87d0d] hover:bg-[#ff8f1c] text-white rounded-lg disabled:opacity-50 transition-colors shadow-md shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </form>
      </div>
    </div>
  );
};
