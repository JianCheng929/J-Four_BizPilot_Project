import { useState } from 'react';
import { ArrowRight, Bot, Compass, Plug, Sparkles } from 'lucide-react';
import type { BusinessSettings } from '@/lib/db/types';
import { defaultSettings } from '@/lib/db/defaults';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const MODES = [
  { key: 'online' as const, label: 'Online store', desc: 'You sell primarily on marketplaces (Shopee, Lazada, TikTok Shop) and ship to customers.' },
  { key: 'retail' as const, label: 'Physical retail', desc: 'You sell mostly through a shopfront or POS — walk-in customers.' },
  { key: 'hybrid' as const, label: 'Hybrid (both)', desc: 'You have both an online presence and a physical counter / café / shop.' },
];

export function Onboarding({ onCreate, onCancel }: { onCreate: (s: Partial<BusinessSettings>) => Promise<void>; onCancel?: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<BusinessSettings['mode']>(defaultSettings.mode);
  const [audience, setAudience] = useState('');
  const [voice, setVoice] = useState('Warm, friendly and professional. No medical or weight-loss claims.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async () => {
    if (!name.trim()) {
      setStep(1);
      return setError('Please enter your business name.');
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), mode, targetAudience: audience, brandVoice: voice });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#f7f8f7] px-4 py-10">
      <div className="w-full max-w-2xl">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-700 text-white">
            <Compass className="h-5 w-5" />
          </div>
          <div>
            <div className="text-base font-semibold tracking-tight">{onCancel ? 'Add another business' : 'Welcome to BizPilot'}</div>
            <div className="text-xs text-slate-500">{onCancel ? 'It gets its own products, money, team and agent. Switch any time from your profile menu.' : 'Your AI business operations agent'}</div>
          </div>
          {onCancel && <Button variant="outline" size="sm" className="ml-4" onClick={onCancel}>Cancel</Button>}
        </div>

        <Card className="border-slate-200 shadow-sm">
          <CardContent className="p-6">
            {/* Steps indicator */}
            <div className="mb-5 flex items-center gap-2 text-[11px] font-medium text-slate-500">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex flex-1 items-center gap-2">
                  <span
                    className={cn(
                      'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold',
                      i <= step ? 'bg-teal-700 text-white' : 'bg-slate-200 text-slate-500',
                    )}
                  >
                    {i + 1}
                  </span>
                  {i < 3 && <span className={cn('h-px flex-1', i < step ? 'bg-teal-700' : 'bg-slate-200')} />}
                </div>
              ))}
            </div>

            {step === 0 && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-teal-700" />
                  <h2 className="text-lg font-semibold">Hi, I'm your BizPilot operations agent</h2>
                </div>
                <p className="text-sm leading-relaxed text-slate-600">
                  I run on WorkBuddy and work on your real business records. Things like:
                </p>
                <ul className="space-y-1.5 text-sm text-slate-700">
                  <li>• "I want to sell <em>toys</em> online" → I set up your business plan, product catalogue, supplier shortlist and a checklist of integrations to connect.</li>
                  <li>• "Reorder more kopi" → I prepare a draft purchase order for your approval.</li>
                  <li>• "Post about our new drop" → I write 3 on-brand captions and save them as drafts.</li>
                  <li>• "Reply to the negative review" → I draft a reply per your brand voice. Nothing is posted without your OK.</li>
                </ul>
                <p className="text-sm text-slate-600">
                  Let's take 2 minutes to set up your business profile, then I'll take you to the next step.
                </p>
                <div className="flex justify-end">
                  <Button onClick={() => setStep(1)} className="bg-teal-700 hover:bg-teal-800">
                    Get started <ArrowRight className="ml-1 h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">What is your business called?</h2>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Business name</Label>
                  <Input
                    autoFocus
                    placeholder="e.g. ToyLah, Kota Kinabalu Coffee, Hana Boutique…"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setStep(0)}>Back</Button>
                  <Button onClick={() => setStep(2)} className="bg-teal-700 hover:bg-teal-800">
                    Next <ArrowRight className="ml-1 h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">How do you sell?</h2>
                <div className="grid gap-2">
                  {MODES.map((m) => (
                    <button
                      key={m.key}
                      onClick={() => setMode(m.key)}
                      className={cn(
                        'rounded-lg border p-3 text-left transition-colors',
                        mode === m.key ? 'border-teal-700 bg-teal-50/50' : 'border-slate-200 hover:border-slate-300',
                      )}
                    >
                      <div className="text-sm font-semibold">{m.label}</div>
                      <div className="text-xs text-slate-600">{m.desc}</div>
                    </button>
                  ))}
                </div>
                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
                  <Button onClick={() => setStep(3)} className="bg-teal-700 hover:bg-teal-800">
                    Next <ArrowRight className="ml-1 h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">Who are you selling to?</h2>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Target audience</Label>
                  <Textarea
                    rows={2}
                    placeholder="e.g. Parents of kids aged 4-10 in Klang Valley who buy educational toys online."
                    value={audience}
                    onChange={(e) => setAudience(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Brand voice</Label>
                  <Textarea
                    rows={2}
                    value={voice}
                    onChange={(e) => setVoice(e.target.value)}
                  />
                </div>
                {error && <p className="text-xs text-red-600">{error}</p>}
                <div className="flex justify-between">
                  <Button variant="outline" onClick={() => setStep(2)}>Back</Button>
                  <Button onClick={finish} disabled={busy} className="bg-teal-700 hover:bg-teal-800">
                    Finish setup <ArrowRight className="ml-1 h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-slate-400">
          <Sparkles className="h-3 w-3" /> After setup, add your company and tax details in <strong className="ml-1">Settings</strong> and connect your sales channels.
          <Plug className="ml-1 h-3 w-3" />
        </div>
      </div>
    </div>
  );
}
