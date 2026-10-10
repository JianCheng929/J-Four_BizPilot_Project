import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { useBizPilot } from '@/lib/store';
import * as ops from '@/lib/ops';
import type { SupportTicket } from '@/lib/db/types';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Field, NONE, SimpleSelect, fromDateInput, primaryBtn, todayInput } from './common';

export const REVIEW_SOURCES = ['Shopee', 'Lazada', 'TikTok Shop', 'Google', 'Facebook', 'Instagram', 'WhatsApp', 'In store', 'Other'];
export const REVIEW_TOPICS = ['quality', 'price', 'delivery', 'packaging', 'service', 'value', 'other'];

export function ReviewDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { db, run } = useBizPilot();
  const [source, setSource] = useState('Google');
  const [name, setName] = useState('');
  const [rating, setRating] = useState(5);
  const [text, setText] = useState('');
  const [productId, setProductId] = useState(NONE);
  const [date, setDate] = useState(todayInput());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSource('Google');
    setName('');
    setRating(5);
    setText('');
    setProductId(NONE);
    setDate(todayInput());
    setError(null);
  }, [open]);

  const preview = text.trim() ? ops.classifyReview(rating, text) : null;

  const save = () => {
    if (!text.trim()) return setError('Paste or type the review text.');
    const res = run(
      (d, a) =>
        ops.addReview(
          d,
          {
            source,
            customerName: name.trim() || 'Anonymous',
            rating,
            text: text.trim(),
            productId: productId === NONE ? null : productId,
            date: fromDateInput(date),
          },
          a,
        ),
      'Review added',
    );
    if (res !== undefined) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a review</DialogTitle>
          <DialogDescription>For reviews from places BizPilot doesn't sync automatically. Sentiment and topic are classified for you.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Source">
            <SimpleSelect value={source} onChange={setSource} options={REVIEW_SOURCES.map((s) => ({ value: s, label: s }))} />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Customer name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Anonymous" />
          </Field>
          <Field label="Product (optional)">
            <SimpleSelect
              value={productId}
              onChange={setProductId}
              options={[{ value: NONE, label: 'Not product specific' }, ...db.products.map((p) => ({ value: p.id, label: p.name }))]}
            />
          </Field>
          <Field label="Rating" className="col-span-2">
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" onClick={() => setRating(n)} aria-label={`${n} stars`}>
                  <Star className={cn('h-6 w-6', n <= rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300')} />
                </button>
              ))}
            </div>
          </Field>
          <Field label="Review text" className="col-span-2">
            <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          {preview && (
            <div className="col-span-2 text-xs text-slate-500">
              Will be classified as <b>{preview.sentiment}</b> · topic <b>{preview.topic}</b>
            </div>
          )}
        </div>
        {error && <div className="text-xs text-red-600">{error}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className={primaryBtn} onClick={save}>
            Add review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TicketDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { run } = useBizPilot();
  const [f, setF] = useState({ subject: '', customerName: '', customerEmail: '', body: '' });
  const [priority, setPriority] = useState<SupportTicket['priority']>('medium');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setF({ subject: '', customerName: '', customerEmail: '', body: '' });
    setPriority('medium');
    setError(null);
  }, [open]);

  const save = () => {
    if (!f.subject.trim()) return setError('Subject is required.');
    if (f.customerEmail && !/^\S+@\S+\.\S+$/.test(f.customerEmail.trim())) return setError('Invalid email.');
    const res = run(
      (d, a) =>
        ops.addTicket(
          d,
          {
            subject: f.subject.trim(),
            customerName: f.customerName.trim(),
            customerEmail: f.customerEmail.trim(),
            body: f.body.trim(),
            priority,
          },
          a,
        ),
      'Ticket created',
    );
    if (res) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New support ticket</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Subject *" className="col-span-2">
            <Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="e.g. Parcel arrived damaged" />
          </Field>
          <Field label="Customer name">
            <Input value={f.customerName} onChange={(e) => setF({ ...f, customerName: e.target.value })} />
          </Field>
          <Field label="Customer email">
            <Input value={f.customerEmail} onChange={(e) => setF({ ...f, customerEmail: e.target.value })} />
          </Field>
          <Field label="Priority">
            <SimpleSelect
              value={priority}
              onChange={(v) => setPriority(v as SupportTicket['priority'])}
              options={[
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
              ]}
            />
          </Field>
          <Field label="Details" className="col-span-2">
            <Textarea rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
          </Field>
        </div>
        {error && <div className="text-xs text-red-600">{error}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className={primaryBtn} onClick={save}>
            Create ticket
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
