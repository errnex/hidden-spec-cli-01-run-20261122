// mend: apply an AI-written edit to a tree of text files.
//
// One command-line tool, four patch formats (unified diffs, SEARCH/REPLACE
// blocks, V4A patches, JSON tool calls), to the specification in SPEC.md.
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
//
// Sections of SPEC.md: 1 command line, 2 output and exit codes, 3 files,
// lines and paths, 4 format detection, 5 three-tier line matching, 6 unified
// diffs, 7 SEARCH/REPLACE blocks, 8 V4A patches, 9 JSON edits, 10 order and
// atomicity. The last lines hand a trial over to runner.ts when
// MAKEFUN_ENV_URL is set: keep them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split into its lines: its own break, its lines, whether it ends with one. */
interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}
function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}
function isOnlyWs(s: string): boolean {
  return s !== '' && /^[ \t]+$/.test(s);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order: [old path, new path]. Drives the `R` output lines. */
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One line of the replacement text: a context line (taken from the file at
 *  its position in O) or an added line (written as-is, or re-indented). */
interface NLine {
  text: string;
  /** Index of this line in O when it is a context line, null when added. */
  ctx: number | null;
}

/** Section 5: a line normalised for a tier (0 exact, 1 trailing ws stripped, 2 both ends stripped). */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where O occurs in `lines` at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const first = norm(o[0], tier);
  const rest = o.slice(1).map((l) => norm(l, tier));
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    if (norm(lines[i], tier) !== first) continue;
    let ok = true;
    for (let j = 0; j < rest.length; j++) {
      if (norm(lines[i + 1 + j], tier) !== rest[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at or after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Build the replacement lines for a match at `pos`: context lines are the
 *  file's own matched lines; at tier 2 every other line is re-indented from
 *  O's first line's leading whitespace to the file's first matched line's. */
function buildNew(lines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(lines[pos] ?? '');
    p = leadingWs(o[0]);
  }
  for (const item of n) {
    if (item.ctx !== null) {
      out.push(lines[pos + item.ctx]);
      continue;
    }
    let t = item.text;
    if (tier === 2 && o.length > 0 && t !== '' && !isOnlyWs(t) && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

function spliceLines(lines: string[], pos: number, remove: number, insert: string[]): string[] {
  return [...lines.slice(0, pos), ...insert, ...lines.slice(pos + remove)];
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------------- Section 6: unified diffs ---------------- */

/** One body line of a hunk: ' ' context, '-' old, '+' new, '\\' no-newline marker. */
interface BodyLine {
  k: ' ' | '-' | '+' | '\\';
  text: string;
}
interface Hunk {
  /** The -A of the `@@ -A[,B] +C[,D] @@` header. */
  a: number;
  body: BodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoEol: boolean;
}
interface Section {
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  gitOld: string | null | undefined;
  gitNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path of a `--- <path>` / `+++ <path>` header line: text after the four
 *  characters, up to the first tab, surrounding spaces removed, a leading
 *  `a/` or `b/` removed; `/dev/null` is null (no file). */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function isDiffGitLine(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}
/** Parse `diff --git a/<X> b/<Y>`; null when not of that form. */
function parseDiffGit(line: string): { x: string; y: string } | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
  if (m === null) return null;
  return { x: m[1], y: m[2] };
}
/** Parse `@@ -A[,B] +C[,D] @@` (optionally followed by text); null otherwise. */
function parseHunkHeader(line: string): { a: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) return null;
  return { a: Number(m[1]) };
}

function isBodyLine(line: string): boolean {
  return line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\';
}

function finishHunk(h: Hunk): void {
  while (h.body.length > 0) {
    const last = h.body[h.body.length - 1];
    if (last.k === ' ' && last.text === '') h.body.pop();
    else break;
  }
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let i = 0; i < h.body.length; i++) {
    if (h.body[i].k === ' ' || h.body[i].k === '+') lastCtxPlus = i;
    if (h.body[i].k === '+') lastPlus = i;
  }
  h.noEol = lastCtxPlus >= 0 && h.body[lastCtxPlus + 1] !== undefined && h.body[lastCtxPlus + 1].k === '\\';
  h.plusNoEol = lastPlus >= 0 && h.body[lastPlus + 1] !== undefined && h.body[lastPlus + 1].k === '\\';
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let headerDone = false;
  let hunk: Hunk | null = null;
  const endHunk = (): void => {
    if (hunk !== null) {
      finishHunk(hunk);
      hunk = null;
    }
  };
  const newSection = (s: Section): void => {
    sections.push(s);
    cur = s;
    headerDone = false;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (hunk !== null) {
      if (isDiffGitLine(line) || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        endHunk();
      } else if (isBodyLine(line)) {
        hunk.body.push({ k: line === '' ? ' ' : (line[0] as ' ' | '-' | '+' | '\\'), text: line === '' ? '' : line.slice(1) });
        i++;
        continue;
      } else {
        endHunk();
      }
    }
    if (isDiffGitLine(line)) {
      const m = parseDiffGit(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      endHunk();
      newSection({ hdrOld: undefined, hdrNew: undefined, gitOld: m.x, gitNew: m.y, renameFrom: undefined, renameTo: undefined, isCreate: false, isDelete: false, hunks: [] });
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]);
      if (cur !== null && !headerDone) {
        cur.hdrOld = oldP;
        cur.hdrNew = newP;
      } else {
        newSection({ hdrOld: oldP, hdrNew: newP, gitOld: undefined, gitNew: undefined, renameFrom: undefined, renameTo: undefined, isCreate: false, isDelete: false, hunks: [] });
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && !headerDone) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = parseHunkHeader(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      endHunk();
      hunk = { a: m.a, body: [], noEol: false, plusNoEol: false };
      cur.hunks.push(hunk);
      headerDone = true;
      i++;
      continue;
    }
    if (cur !== null && !headerDone) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.isCreate = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  endHunk();
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Split one hunk body into its old lines O and its new lines N. */
function hunkON(h: Hunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of h.body) {
    if (b.k === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.k === '-') {
      o.push(b.text);
    } else if (b.k === '+') {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

/** Apply a section's hunks to `lines` (its result of the hunks before), tracking the final line break. */
function applyHunks(lines: string[], finalIn: boolean, hunks: Hunk[], strict: boolean, errPath: string): { lines: string[]; final: boolean } {
  let cur = lines;
  let final = finalIn;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > cur.length) pos = cur.length;
      const atEnd = pos === cur.length;
      const ins = buildNew(cur, pos, [], n, 0);
      cur = spliceLines(cur, pos, 0, ins);
      if (atEnd) final = !h.noEol;
      d += n.length;
    } else {
      const found = findTier(cur, o, strict, 0);
      if (found === null) throw new Fail('no-match', errPath);
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const toEnd = best + o.length === cur.length;
      const rep = buildNew(cur, best, o, n, found.tier);
      cur = spliceLines(cur, best, o.length, rep);
      if (toEnd) final = !h.noEol;
      d += n.length - o.length;
    }
  }
  return { lines: cur, final };
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldP = s.hdrOld !== undefined ? s.hdrOld : s.renameFrom !== undefined ? s.renameFrom : s.gitOld !== undefined ? s.gitOld : '';
  const newP = s.hdrNew !== undefined ? s.hdrNew : s.renameTo !== undefined ? s.renameTo : s.gitNew !== undefined ? s.gitNew : '';
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = s.isCreate || oldP === null;
    const isDelete = !isCreate && (s.isDelete || newP === null);
    if (isCreate) {
      const np = newP as string;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let final = false;
      let lastPlusHunk: Hunk | null = null;
      for (const h of s.hunks) {
        let hasPlus = false;
        for (const b of h.body) {
          if (b.k === '+') {
            plus.push(b.text);
            hasPlus = true;
          }
        }
        if (hasPlus) lastPlusHunk = h;
      }
      if (lastPlusHunk !== null) final = !lastPlusHunk.plusNoEol;
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    const op = oldP as string;
    if (isDelete) {
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const np = newP as string;
    const isMove = op !== np;
    if (tree.get(op) === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const before = tree.get(op) as string;
    const parts = splitFile(before);
    const res = applyHunks(parts.lines, parts.final, s.hunks, strict, op);
    const out = joinFile(res.lines, parts.br, res.final);
    if (isMove) {
      tree.now.set(np, out);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
    } else {
      tree.now.set(op, out);
    }
  };
}

/* ---------------- Section 7: SEARCH/REPLACE blocks ---------------- */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitFile(before);
    const found = findTier(parts.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0];
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const rep = buildNew(parts.lines, pos, oldLines, n, found.tier);
    const lines = spliceLines(parts.lines, pos, oldLines.length, rep);
    tree.now.set(path, joinFile(lines, parts.br, parts.final));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    edits.push(searchReplaceEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* ---------------- Section 8: V4A patches ---------------- */

interface V4aChunk {
  /** Null: no anchor. */
  anchor: string | null;
  eof: boolean;
  ops: BodyLine[];
}
interface V4aLine {
  text: string;
  /** 1-based patch line number. */
  num: number;
}

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function isV4aSectionStart(line: string): boolean {
  return line.startsWith(V4A_ADD) || line.startsWith(V4A_DEL) || line.startsWith(V4A_UPD);
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = splitFile(before);
    let lines = parts.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = findTier(lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0] + 1;
      }
      const o: string[] = [];
      const n: NLine[] = [];
      for (const b of ch.ops) {
        if (b.k === ' ') {
          o.push(b.text);
          n.push({ text: b.text, ctx: o.length - 1 });
        } else if (b.k === '-') {
          o.push(b.text);
        } else if (b.k === '+') {
          n.push({ text: b.text, ctx: null });
        }
      }
      if (o.length === 0) {
        const pos = ch.eof ? lines.length : cursor;
        const ins = buildNew(lines, pos, [], n, 0);
        lines = spliceLines(lines, pos, 0, ins);
        cursor = pos + ins.length;
      } else {
        const found = findTier(lines, o, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let cands = found.occ;
        if (ch.eof) cands = cands.filter((p) => p + o.length === lines.length);
        if (cands.length === 0) throw new Fail('no-match', path);
        const pos = cands[0];
        const rep = buildNew(lines, pos, o, n, found.tier);
        lines = spliceLines(lines, pos, o.length, rep);
        cursor = pos + rep.length;
      }
    }
    const out = joinFile(lines, parts.br, parts.final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (line.startsWith(V4A_ADD)) {
      kind = 'add';
      path = line.slice(V4A_ADD.length).trim();
    } else if (line.startsWith(V4A_DEL)) {
      kind = 'del';
      path = line.slice(V4A_DEL.length).trim();
    } else if (line.startsWith(V4A_UPD)) {
      kind = 'upd';
      path = line.slice(V4A_UPD.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i++;
    const raw: V4aLine[] = [];
    while (i < last && !isV4aSectionStart(lines[i])) {
      raw.push({ text: lines[i], num: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1].text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text[0] === '+') fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0].num}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let pos = 0;
      if (raw.length > 0 && raw[0].text.startsWith(V4A_MOVE)) {
        moveTo = raw[0].text.slice(V4A_MOVE.length).trim();
        pos = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let started = false;
      let betweenChunks = false;
      for (; pos < raw.length; pos++) {
        const r = raw[pos];
        const text = r.text;
        if (text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.num}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          betweenChunks = true;
          continue;
        }
        if (text.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: text.slice(2).trim(), eof: false, ops: [] };
          started = true;
          betweenChunks = false;
          continue;
        }
        if (text.startsWith('*** ')) throw new Exit2(`error: parse ${r.num}`);
        if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
          if (cur === null) {
            if (!started && !betweenChunks) {
              cur = { anchor: null, eof: false, ops: [] };
              started = true;
            } else {
              throw new Exit2(`error: parse ${r.num}`);
            }
          }
          cur.ops.push({ k: text === '' ? ' ' : (text[0] as ' ' | '-' | '+'), text: text === '' ? '' : text.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${r.num}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

/* ---------------- Section 10: order, atomicity, output ---------------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: one line per changed path, byte order; a successful move
  // reports `R <old> -> <new>` (sorting by <new>) instead of its D and A pair.
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  const moveFrom = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    if (!moveFrom.has(o)) moveFrom.set(o, n);
  }
  const targets = new Set(moveFrom.values());
  for (const o of moveFrom.keys()) {
    if (targets.has(o)) continue;
    const seen = new Set<string>([o]);
    let dest = moveFrom.get(o)!;
    let cyclic = false;
    while (moveFrom.has(dest)) {
      if (seen.has(dest)) {
        cyclic = true;
        break;
      }
      seen.add(dest);
      dest = moveFrom.get(dest)!;
    }
    if (cyclic) continue;
    const wasO = tree.original(o);
    const nowO = tree.now.has(o) ? tree.now.get(o)! : tree.original(o);
    const wasD = tree.original(dest);
    const nowD = tree.now.has(dest) ? tree.now.get(dest)! : tree.original(dest);
    if (wasO !== null && nowO === null && wasD === null && nowD !== null) {
      rows.push({ key: dest, line: `R ${o} -> ${dest}` });
      covered.add(o);
      covered.add(dest);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
