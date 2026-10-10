import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * BizPilot skills: detailed playbooks in server/skills/<name>/SKILL.md that ship
 * with the server. The agent sees each skill's name and description in its
 * instructions and loads the full text with the load_skill tool when a request
 * matches, like WorkBuddy's own skills.
 */

export interface Skill { name: string; description: string; body: string }

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
let cache: Skill[] | null = null;

function parse(text: string, fallback: string): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const meta = m ? m[1] : '';
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(meta)?.[1].trim().replace(/^["']|["']$/g, '') ?? '';
  return { name: field('name') || fallback, description: field('description'), body: (m ? m[2] : text).trim() };
}

export function listSkills(): Skill[] {
  if (cache) return cache;
  cache = existsSync(SKILLS_DIR)
    ? readdirSync(SKILLS_DIR)
        .filter((d) => existsSync(join(SKILLS_DIR, d, 'SKILL.md')))
        .map((d) => parse(readFileSync(join(SKILLS_DIR, d, 'SKILL.md'), 'utf8'), d))
    : [];
  return cache;
}

export function getSkill(name: string) {
  const n = name.trim().toLowerCase();
  return listSkills().find((s) => s.name.toLowerCase() === n);
}

/** The short list that goes into the agent's instructions. */
export function skillsIndex() {
  const skills = listSkills();
  if (!skills.length) return '';
  return `Skills (detailed playbooks). When a request matches one, call load_skill with its name FIRST and follow it:\n${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`;
}
