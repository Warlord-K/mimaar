import React, { useState, useRef, useEffect } from 'react';
import {
  ChatMessage,
  AgentAction,
  LidarMetadata,
  LidarFilterState,
  LidarRenderSettings
} from '../types/lidar';
import { ArrowUp, Check, Loader2, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface LidarAgentChatProps {
  metadata: LidarMetadata;
  filterState: LidarFilterState;
  renderSettings: LidarRenderSettings;
  onExecuteAgentAction: (action: AgentAction) => void;
}

const STARTERS = [
  'Strip ground to show the canopy',
  'Isolate buildings',
  'Color by elevation with turbo',
  'Remove noise',
  'Summarize this scan'
];

function renderInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={i} className="font-semibold text-foreground">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    )
  );
}

export const LidarAgentChat: React.FC<LidarAgentChatProps> = ({
  metadata,
  filterState,
  renderSettings,
  onExecuteAgentAction
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isLoading]);

  const send = async (text?: string) => {
    const prompt = (text ?? input).trim();
    if (!prompt || isLoading) return;

    const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setMessages(prev => [...prev, { id: `u_${Date.now()}`, sender: 'user', content: prompt, timestamp: now() }]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/v1/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-requested-by': 'lidar-web-client' },
        body: JSON.stringify({
          message: prompt,
          history: messages.slice(-6).map(m => ({ role: m.sender, content: m.content })),
          sceneSummary: {
            filename: metadata.filename,
            format: metadata.format,
            pointCount: metadata.pointCount,
            densityPerSqMeter: metadata.densityPerSqMeter,
            elevationRange: [metadata.bounds.minZ, metadata.bounds.maxZ],
            bounds: metadata.bounds,
            availableClasses: Object.keys(metadata.classCounts).map(Number),
            activeClasses: Array.from(filterState.enabledClasses),
            colorMode: renderSettings.colorMode,
            colormap: renderSettings.colormap,
            decimationRate: filterState.decimationRate,
            cropBoxEnabled: filterState.cropBoxEnabled
          }
        })
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const data = await response.json();
      const actions: AgentAction[] = Array.isArray(data.actions) ? data.actions : [];

      setMessages(prev => [
        ...prev,
        {
          id: `a_${Date.now()}`,
          sender: 'assistant',
          content: data.reply || 'Done.',
          timestamp: now(),
          actionsExecuted: actions,
          suggestedPrompts: data.suggestedFollowUps || []
        }
      ]);
      actions.forEach(onExecuteAgentAction);
    } catch (err: any) {
      setMessages(prev => [
        ...prev,
        {
          id: `e_${Date.now()}`,
          sender: 'system',
          content: `The agent is unreachable right now (${err.message || err}). Try again in a moment.`,
          timestamp: now()
        }
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const lastAssistant = [...messages].reverse().find(m => m.sender === 'assistant');
  const suggestions = messages.length === 0 ? STARTERS : lastAssistant?.suggestedPrompts ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <span className="text-sm font-medium">Agent</span>
        </div>
        {messages.length > 0 && (
          <Button size="icon-sm" variant="ghost" onClick={() => setMessages([])} aria-label="Clear chat">
            <Trash2 />
          </Button>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col justify-end gap-1.5 pb-2">
            <p className="text-sm font-medium">Tell the agent what to do.</p>
            <p className="text-sm text-muted-foreground">
              It can filter classes, slice by height, crop, clean noise and restyle the cloud.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map(msg => (
              <div key={msg.id} className={cn('flex flex-col gap-2', msg.sender === 'user' && 'items-end')}>
                <div
                  className={cn(
                    'max-w-[90%] whitespace-pre-wrap text-sm leading-relaxed select-text',
                    msg.sender === 'user' && 'rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-primary-foreground',
                    msg.sender === 'assistant' && 'text-foreground/90',
                    msg.sender === 'system' && 'rounded-lg bg-destructive/10 px-3 py-2 text-destructive'
                  )}
                >
                  {renderInline(msg.content)}
                </div>
                {msg.actionsExecuted && msg.actionsExecuted.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {msg.actionsExecuted.map(act => (
                      <span
                        key={act.id}
                        title={act.explanation}
                        className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        <Check className="size-3 text-primary" />
                        {act.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {isLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Working on it
              </div>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-2.5 border-t p-3">
        {suggestions.length > 0 && !isLoading && (
          <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
            {suggestions.map(s => (
              <Button key={s} size="xs" variant="outline" className="shrink-0 font-normal" onClick={() => send(s)}>
                {s}
              </Button>
            ))}
          </div>
        )}
        <form
          onSubmit={e => {
            e.preventDefault();
            send();
          }}
          className="flex items-center gap-2"
        >
          <Input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask the agent..."
            className="h-9"
          />
          <Button type="submit" size="icon-lg" disabled={!input.trim() || isLoading} aria-label="Send">
            <ArrowUp />
          </Button>
        </form>
      </div>
    </div>
  );
};
