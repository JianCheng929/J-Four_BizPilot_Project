import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Renders the small Markdown subset WorkBuddy writes (headings, bold, italics,
 * inline code, bullet and numbered lists, rules). Builds React elements only,
 * never raw HTML, so agent text can't inject markup.
 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(!\[[^\]]*\]\(https:\/\/[^)\s]+\)|\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const image = /^!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)$/.exec(t);
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t);
    if (image) out.push(<a key={m.index} href={image[2]} target="_blank" rel="noopener noreferrer" className="my-1 inline-block"><img src={image[2]} alt={image[1]} className="max-h-72 max-w-full rounded-lg border object-contain" /></a>);
    else if (link) out.push(<a key={m.index} href={link[2]} target="_blank" rel="noopener noreferrer" className="font-medium text-teal-700 underline underline-offset-2">{link[1]}</a>);
    else if (t.startsWith('**') || t.startsWith('__')) out.push(<strong key={m.index} className="font-semibold">{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={m.index} className="rounded bg-slate-100 px-1 text-[0.85em]">{t.slice(1, -1)}</code>);
    else out.push(<em key={m.index}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{para.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{inline(l)}</Fragment>)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it)}</li>);
    blocks.push(list.ordered
      ? <ol key={blocks.length} className="list-decimal space-y-1 pl-5">{items}</ol>
      : <ul key={blocks.length} className="list-disc space-y-1 pl-5">{items}</ul>);
    list = null;
  };

  let table: string[][] | null = null;
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const flushTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    const num = (c: string) => /^[-+]?(RM\s?)?[-+]?[\d,]+(\.\d+)?%?$/i.test(c);
    blocks.push(
      <div key={blocks.length} className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-slate-50">
            <tr>{head.map((c, i) => <th key={i} className="border-b border-slate-200 px-3 py-2 text-left font-semibold text-slate-700">{inline(c)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="odd:bg-white even:bg-slate-50/60">
                {head.map((_, j) => <td key={j} className={cn('border-b border-slate-100 px-3 py-2 align-top', num(r[j] ?? '') && 'text-right tabular-nums')}>{inline(r[j] ?? '')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    table = null;
  };

  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara(); flushList();
      if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue; // header separator
      (table ??= []).push(cells(line));
      continue;
    }
    flushTable();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); flushList(); blocks.push(<hr key={blocks.length} className="border-slate-200" />); continue; }
    if (heading) { flushPara(); flushList(); blocks.push(<p key={blocks.length} className="font-semibold text-slate-900">{inline(heading[2])}</p>); continue; }
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  flushTable();
  return <div className={cn('space-y-2 break-words', className)}>{blocks}</div>;
}
