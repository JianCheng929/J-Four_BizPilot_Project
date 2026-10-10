import { useRef, useState } from 'react';
import { Building2, Camera, Check, ChevronsUpDown, KeyRound, Loader2, LogOut, Plus, Settings as SettingsIcon, Trash2, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { useBizPilot } from '@/lib/store';
import { useAccount } from '@/lib/account';
import { getSupabase } from '@/lib/db/supabase';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, primaryBtn } from '@/components/bizpilot/common';
import type { PageKey } from './AppShell';

const ROLE: Record<string, string> = { owner: 'Owner', manager: 'Manager', staff: 'Staff', viewer: 'Viewer' };

/** Opens a Settings tab (works whether or not Settings is already open). */
function openSettings(onNavigate: (p: PageKey) => void, tab: string) {
  try { sessionStorage.setItem('bp.settingsTab', tab); } catch { /* optional */ }
  onNavigate('settings');
  window.dispatchEvent(new CustomEvent('bp:settings-tab', { detail: tab }));
}

function initials(name: string) {
  const parts = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

function UserAvatar({ url, name, className }: { url?: string; name: string; className?: string }) {
  return url ? (
    <img src={url} alt="" className={cn('h-8 w-8 rounded-full object-cover', className)} />
  ) : (
    <div className={cn('flex h-8 w-8 items-center justify-center rounded-full bg-teal-700 text-xs font-semibold text-white', className)}>{initials(name)}</div>
  );
}

/** The signed-in person's name and photo (kept in their Supabase login, the same in every business). */
function useProfile() {
  const { session } = useBizPilot();
  const meta = (session.user.user_metadata ?? {}) as { full_name?: string; avatar_url?: string };
  const email = session.user.email ?? '';
  return { id: session.user.id, email, name: meta.full_name?.trim() || email.replace(/@.*/, ''), fullName: meta.full_name ?? '', avatar: meta.avatar_url };
}

/** Square-crops and shrinks a picture to a small JPEG. */
async function squareJpeg(file: File, size = 256): Promise<Blob> {
  const img = await createImageBitmap(file);
  const side = Math.min(img.width, img.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d')!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  img.close();
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('Could not read that picture.'))), 'image/jpeg', 0.85));
}

function ProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const me = useProfile();
  const [name, setName] = useState(me.fullName);
  const [photo, setPhoto] = useState<{ blob: Blob; preview: string } | null | 'remove'>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const shown = photo === 'remove' ? undefined : photo ? photo.preview : me.avatar;

  const pick = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast.error('Choose a picture (JPG, PNG or WebP).');
    try {
      const blob = await squareJpeg(file);
      setPhoto({ blob, preview: URL.createObjectURL(blob) });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const save = async () => {
    const supa = getSupabase()!;
    setSaving(true);
    try {
      let avatar_url = me.avatar ?? '';
      const old = me.avatar?.match(/\/avatars\/(.+)$/)?.[1];
      if (photo && photo !== 'remove') {
        const path = `${me.id}/${Date.now()}.jpg`;
        const up = await supa.storage.from('avatars').upload(path, photo.blob, { contentType: 'image/jpeg' });
        if (up.error) throw new Error(/bucket/i.test(up.error.message) ? 'Photo storage is not set up yet: run supabase/industrial.sql in Supabase once.' : up.error.message);
        avatar_url = supa.storage.from('avatars').getPublicUrl(path).data.publicUrl;
      } else if (photo === 'remove') {
        avatar_url = '';
      }
      const { error } = await supa.auth.updateUser({ data: { full_name: name.trim(), avatar_url } });
      if (error) throw new Error(error.message);
      if (old && avatar_url !== me.avatar) void supa.storage.from('avatars').remove([decodeURIComponent(old)]);
      toast.success('Profile saved');
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Your profile</DialogTitle></DialogHeader>
        <div className="flex items-center gap-4">
          <UserAvatar url={shown} name={name || me.email} className="h-16 w-16 text-lg" />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}><Camera className="mr-1.5 h-4 w-4" />{shown ? 'Change photo' : 'Upload photo'}</Button>
            {shown && <Button variant="ghost" size="sm" onClick={() => setPhoto('remove')}><Trash2 className="mr-1.5 h-4 w-4" />Remove</Button>}
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
          </div>
        </div>
        <Field label="Your name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ng Wei Bin" maxLength={80} /></Field>
        <Field label="Email" hint="Your sign-in email can't be changed here."><Input value={me.email} disabled /></Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className={primaryBtn} onClick={save} disabled={saving}>{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Businesses this login can open, with the current one ticked. */
function BusinessItems() {
  const { business } = useBizPilot();
  const account = useAccount();
  if (!account) return null;
  return (
    <>
      <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Businesses</DropdownMenuLabel>
      {account.businesses.map((b) => (
        <DropdownMenuItem key={b.id} onSelect={() => account.switchBusiness(b.id)} className="gap-2">
          <Building2 className="h-4 w-4 text-slate-400" />
          <span className="min-w-0 flex-1 truncate">{b.name}</span>
          <span className="text-[10px] text-slate-400">{ROLE[b.role ?? 'owner']}</span>
          <Check className={cn('h-4 w-4 text-teal-700', b.id !== business.id && 'invisible')} />
        </DropdownMenuItem>
      ))}
      <DropdownMenuItem onSelect={account.addBusiness} className="gap-2 text-teal-800">
        <Plus className="h-4 w-4" />Add a new business
      </DropdownMenuItem>
    </>
  );
}

/** Top-right avatar: profile, businesses, settings and sign out. */
export function AccountMenu({ onNavigate }: { onNavigate: (p: PageKey) => void }) {
  const { signOut, role } = useBizPilot();
  const me = useProfile();
  const [editing, setEditing] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="rounded-full ring-offset-2 hover:ring-2 hover:ring-teal-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500" title="Your account">
            <UserAvatar url={me.avatar} name={me.name} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <div className="flex items-center gap-3 px-2 py-2">
            <UserAvatar url={me.avatar} name={me.name} className="h-10 w-10" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{me.name}</div>
              <div className="truncate text-xs text-slate-500">{me.email}</div>
              <div className="text-[11px] text-teal-700">{ROLE[role]} of this business</div>
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setEditing(true)} className="gap-2"><UserRound className="h-4 w-4" />Edit profile and photo</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openSettings(onNavigate, 'team')} className="gap-2"><KeyRound className="h-4 w-4" />Two-step login</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openSettings(onNavigate, 'profile')} className="gap-2"><SettingsIcon className="h-4 w-4" />Settings</DropdownMenuItem>
          <DropdownMenuSeparator />
          <BusinessItems />
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void signOut()} className="gap-2 text-red-700 focus:text-red-700"><LogOut className="h-4 w-4" />Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {editing && <ProfileDialog open onOpenChange={setEditing} />}
    </>
  );
}

/** Sidebar footer: the open business, click to switch or add one. */
export function BusinessSwitcher() {
  const { db } = useBizPilot();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="w-full rounded-lg bg-slate-50 p-3 text-left hover:bg-slate-100" title="Switch business">
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-xs font-semibold">{db.settings.name}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[10px] font-medium capitalize text-slate-700">{db.settings.mode}</span>
            <span className="text-[10px] text-slate-500">{db.settings.currency} · {db.settings.country}</span>
          </div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64">
        <BusinessItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
