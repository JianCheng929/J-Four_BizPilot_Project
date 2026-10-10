import type { BizPilotDB } from './db/types';

/**
 * Marketing compliance check (blueprint C1/C2, Module C compliance rules):
 * the owner's prohibited claims, unverified performance/safety/medical claims,
 * guaranteed results, pressure tactics, and prices that don't match the
 * product list. Deterministic, so the same text always gets the same result.
 */

export interface ComplianceIssue {
  level: 'block' | 'warn';
  rule: string;
  match: string;
}

const RULES: { rule: string; level: 'block' | 'warn'; re: RegExp }[] = [
  { rule: 'Guaranteed result', level: 'block', re: /\b(guarantee[ds]?|dijamin|jaminan)\b/i },
  { rule: 'Medical or cure claim', level: 'block', re: /\b(cures?|cured|heals?|treats?|sembuh|ubat|penawar|anti[- ]?(cancer|diabetes|aging))\b/i },
  { rule: 'Unverified safety claim', level: 'block', re: /\b(100%\s*(safe|natural|selamat|semula jadi)|no side[- ]effects?|tiada kesan sampingan|chemical[- ]free)\b/i },
  { rule: 'Unverified approval claim', level: 'warn', re: /\b(clinically proven|doctor[- ]recommended|dermatologist[- ]tested|FDA[- ]approved|KKM[- ]approved|lulus KKM)\b/i },
  { rule: 'Unverified superlative', level: 'warn', re: /(\bno\.?\s?1\b|#1\b|\bnumber one\b|\bbest in (malaysia|the world)\b|\bterbaik di malaysia\b|\blowest price\b|\bharga termurah\b|\bcheapest\b)/i },
  { rule: 'Unrealistic result', level: 'warn', re: /\b(instant(ly)? results?|overnight results?|permanent(ly)?|miracle|ajaib|lose \d+\s?kg|turun \d+\s?kg)\b/i },
  { rule: 'Pressure tactic', level: 'warn', re: /\b(last chance|today only|hari ini sahaja|hurry|buy now or|only \d+ left)\b/i },
];

export function checkCompliance(text: string, db: Pick<BizPilotDB, 'settings' | 'products'>): ComplianceIssue[] {
  const issues: ComplianceIssue[] = [];
  const lower = text.toLowerCase();
  for (const phrase of (db.settings.prohibitedClaims ?? '').split(/[,\n;]/).map((s) => s.trim()).filter((s) => s.length >= 3)) {
    if (lower.includes(phrase.toLowerCase())) issues.push({ level: 'block', rule: 'Your prohibited claim', match: phrase });
  }
  for (const r of RULES) {
    const m = r.re.exec(text);
    if (m) issues.push({ level: r.level, rule: r.rule, match: m[0] });
  }
  const prices = db.products.map((p) => p.price).filter((p) => p > 0);
  if (prices.length) {
    for (const m of text.matchAll(/RM\s?(\d{1,6}(?:\.\d{1,2})?)/gi)) {
      const v = Number(m[1]);
      if (!prices.some((p) => Math.abs(p - v) < 0.01)) issues.push({ level: 'warn', rule: 'Price not in your product list (check discounts are real)', match: m[0] });
    }
  }
  return issues;
}
