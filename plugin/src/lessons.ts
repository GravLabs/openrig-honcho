// V5 (ADR-0019 decision 5, as decided 2026-11-13): lessons at the moment the
// work names a risky action. When a claim pointer arms for a hand-off whose
// summary or first body line names a risky action, this module reads the
// seat's OWN lore folder and returns up to two one-line lesson pointers
// beside the pointer block. Nothing here blocks, models, or touches the
// network; nothing is copied or logged - the caller logs a COUNT only, and
// only a slug plus the Moment line (sanitised, capped) is ever shown.
// This is lesson SUGGESTION's sibling (lesson.ts, V6) - that one never reads
// lore; this one reads it read-only and never writes it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./env.ts";
import { sanitizeVisible } from "./pointer.ts";
import { trustTag } from "./trust.ts";

/** The fixed risky-action list (row brief point 1, one place). */
export const RISKY_WORDS: readonly string[] = [
  "publish", "release", "push", "force", "delete", "remove", "rm", "drop",
  "deploy", "tag", "reset",
];

const MAX_FILES = 50;
const MAX_FILE_BYTES = 64 * 1024;
const MOMENT_CAP = 120;
const MAX_LESSONS = 2;

/** Whole-word, case-insensitive: the first risky word the text names, or null. */
export function riskyWordIn(text: string): string | null {
  const t = text.toLowerCase();
  for (const w of RISKY_WORDS) {
    const re = new RegExp(`(?<![a-z0-9])${w}(?![a-z0-9])`);
    if (re.test(t)) return w;
  }
  return null;
}

/** One parsed lore item: its file name, Moment line and frontmatter date. */
export interface LoreItem {
  slug: string;
  moment: string;
  date: string;
}

/**
 * Parse one lore file. The file must carry a YAML frontmatter block with an
 * exact `taxonomy: lore` line (lore-routing.md: the machine privacy class -
 * a misspelling is not lore), a `date` (the ordering key - filenames never
 * carry dates), and a "**Moment.**" line (the only body text ever shown).
 * Anything else parses to null (skipped, never shown).
 */
export function parseLoreFile(name: string, text: string): LoreItem | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm === null) return null;
  const meta = fm[1] as string;
  if (!/^taxonomy:\s*lore\s*$/m.test(meta)) return null;
  const dm = /^date:\s*"?([^"\r\n]+?)"?\s*$/m.exec(meta);
  const date = dm === null ? "" : (dm[1] as string).trim();
  const mm = /^\*\*Moment\.\*\*\s*(.*)$/m.exec(text);
  if (mm === null) return null;
  const moment = (mm[1] as string).trim();
  if (moment === "") return null;
  return { slug: name, moment, date };
}

/** Word-boundary test for a slug or Moment (lower-cased input). */
function hasWord(word: string, lower: string): boolean {
  return new RegExp(`(?<![a-z0-9])${word}(?![a-z0-9])`).test(lower);
}

/**
 * The lessons for one risky word: slug or Moment match, at most two, newest
 * `date` first (a missing/bad date sorts last; ties by name, stable).
 */
export function pickLessons(items: readonly LoreItem[], word: string): LoreItem[] {
  const matched = items.filter(
    (i) => hasWord(word, i.slug.toLowerCase()) || hasWord(word, i.moment.toLowerCase()),
  );
  matched.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1; // newest first; "" last
    return a.slug < b.slug ? -1 : 1;
  });
  return matched.slice(0, MAX_LESSONS);
}

/** The shown line for one lesson: address + sanitised capped Moment + class.
 * The trust tag rides OUTSIDE the 120-cap (trust.ts truncation rule). */
export function lessonLine(i: LoreItem): string {
  const moment = sanitizeVisible(i.moment).slice(0, MOMENT_CAP);
  return `Your lesson: seat:lore/${i.slug} - ${moment}${trustTag("lore")}`;
}

/** Injectable fs reads (tests pass spies to prove which paths were touched). */
export interface LoreFileReader {
  list: (dir: string) => string[];
  read: (file: string) => string;
  /** size when a regular file, null for anything else (dirs, links to dirs). */
  sizeIsFile: (file: string) => number | null;
}

const realReader: LoreFileReader = {
  list: (dir) => readdirSync(dir),
  read: (file) => readFileSync(file, "utf8"),
  sizeIsFile: (file) => {
    try {
      const st = statSync(file);
      return st.isFile() ? st.size : null;
    } catch {
      return null;
    }
  },
};

/**
 * The lesson block for one claimed hand-off, or "" (nothing to show).
 * Reads ONLY <topologyRoot>/rigs/<rig>/seats/<seat>/lore/ for THIS seat
 * (session name seat@rig - never another seat's folder), at most 50 regular
 * .md files of at most 64 KB each, skipping anything without `taxonomy:
 * lore`. riskText is the row's summary + first body line. Any failure (no
 * setting, no folder, unreadable file) yields "": this never throws, never
 * blocks, and costs no network. `now` is unused (kept for call-site shape).
 */
export function pointerLessons(
  cfg: Pick<Config, "topologyRoot" | "sessionName">,
  riskText: string,
  reader: LoreFileReader = realReader,
): { text: string; count: number } {
  const nothing = { text: "", count: 0 };
  try {
    const root = cfg.topologyRoot ?? "";
    const session = cfg.sessionName ?? "";
    if (root === "" || !session.includes("@")) return nothing;
    const seat = (session.split("@")[0] ?? "").trim();
    const rig = session.slice(session.lastIndexOf("@") + 1).trim();
    if (seat === "" || rig === "") return nothing;
    const word = riskyWordIn(riskText);
    if (word === null) return nothing;
    const dir = join(root, "rigs", rig, "seats", seat, "lore");
    const names = reader
      .list(dir)
      .filter((n) => n.endsWith(".md"))
      .sort();
    const items: LoreItem[] = [];
    let readCount = 0;
    for (const name of names) {
      if (readCount >= MAX_FILES) break;
      const file = join(dir, name);
      const size = reader.sizeIsFile(file);
      if (size === null || size > MAX_FILE_BYTES) continue;
      readCount += 1;
      const parsed = parseLoreFile(name, reader.read(file));
      if (parsed !== null) items.push(parsed);
    }
    const picked = pickLessons(items, word);
    if (picked.length === 0) return nothing;
    return { text: picked.map(lessonLine).join("\n"), count: picked.length };
  } catch {
    return nothing; // any IO damage: silence, never a failed hook
  }
}
