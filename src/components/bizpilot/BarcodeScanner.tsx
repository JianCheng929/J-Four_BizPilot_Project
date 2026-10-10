import { useEffect, useRef, useState } from 'react';
import { Camera, ScanLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Detector { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> }
type DetectorCtor = new (opts?: { formats?: string[] }) => Detector;

const detectorCtor = (): DetectorCtor | null => (typeof window !== 'undefined' && 'BarcodeDetector' in window ? (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector : null);

/** Phone/laptop camera scanning with the browser's built-in barcode reader (Chrome, Edge, Android). */
function CameraScan({ open, onOpenChange, onScan }: { open: boolean; onOpenChange: (o: boolean) => void; onScan: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const cb = useRef({ onScan, onOpenChange });
  useEffect(() => { cb.current = { onScan, onOpenChange }; });
  useEffect(() => {
    if (!open) return;
    const Ctor = detectorCtor();
    if (!Ctor) { queueMicrotask(() => setError('This browser cannot read barcodes with the camera. Use Chrome or Edge, or a USB/Bluetooth scanner in the box.')); return; }
    queueMicrotask(() => setError(null));
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    const detector = new Ctor({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code', 'itf'] });
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' } })
      .then(async (s) => {
        stream = s;
        if (stopped || !video.current) return;
        video.current.srcObject = s;
        await video.current.play().catch(() => undefined);
        const tick = async () => {
          if (stopped || !video.current) return;
          try {
            const found = await detector.detect(video.current);
            if (found[0]?.rawValue) { cb.current.onScan(found[0].rawValue); cb.current.onOpenChange(false); return; }
          } catch { /* frame not ready */ }
          timer = window.setTimeout(tick, 250);
        };
        void tick();
      })
      .catch((e) => setError(`Camera not available: ${(e as Error).message}`));
    return () => { stopped = true; window.clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Scan a barcode</DialogTitle></DialogHeader>
        {error ? <div className="text-sm text-red-600">{error}</div> : (
          <div className="relative overflow-hidden rounded-lg bg-black">
            <video ref={video} className="aspect-[4/3] w-full object-cover" muted playsInline />
            <div className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 bg-red-500/80" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Scan box: a USB/Bluetooth scanner types the code and presses Enter; the camera button reads it with the phone camera.
 */
export function ScanInput({ onScan, placeholder = 'Scan or type a barcode / SKU', autoFocus, className }: { onScan: (code: string) => void; placeholder?: string; autoFocus?: boolean; className?: string }) {
  const [value, setValue] = useState('');
  const [camera, setCamera] = useState(false);
  const submit = () => { const v = value.trim(); if (v) onScan(v); setValue(''); };
  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`}>
      <div className="relative flex-1">
        <ScanLine className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input className="h-9 pl-8" value={value} autoFocus={autoFocus} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => setCamera(true)} title="Scan with the camera"><Camera className="h-4 w-4" /></Button>
      <CameraScan open={camera} onOpenChange={setCamera} onScan={onScan} />
    </div>
  );
}
