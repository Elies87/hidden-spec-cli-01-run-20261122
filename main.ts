// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads a patch in one of four formats — a unified diff,
// SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON — finds the lines each edit names at the
// first of three matching tiers (exact, trailing-whitespace, whitespace-trimmed), and changes every file or none.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** Move pairs (old, new) recorded by move edits that ran to completion, for the `R` output line. */
const moves: Array<[string, string]> = [];

/* ---------------- files as lines (SPEC.md section 3) ---------------- */

interface Model {
  br: string;
  lines: string[];
  final: boolean;
}

function toModel(text: string): Model {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br: '\n', lines: [], final: false };
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, final: fin };
}

function fromModel(m: Model): string {
  return m.lines.length === 0 ? '' : m.lines.join(m.br) + (m.final ? m.br : '');
}

/* ---------------- matching lines (SPEC.md section 5) ---------------- */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(tier: number, a: string, b: string): boolean {
  return tier === 0 ? a === b : tier === 1 ? stripTrail(a) === stripTrail(b) : stripBoth(a) === stripBoth(b);
}

/** Every position at which O occurs in lines at the given tier (occurrences may overlap). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineEq(tier, lines[i + k]!, o[k]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (only tier 0 under --strict), or null. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; at: number[] } | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const at = occurrences(lines, o, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

interface BodyLine {
  t: ' ' | '-' | '+';
  text: string;
}

/**
 * The lines N writes when O matched at `pos` in `lines`: context lines (tagged in `ctx`, mapping an index of N to
 * the index of the same line in O) are written as the file's own matched line; at tier 2 every other line of N is
 * re-indented from O's first line's leading whitespace to the file's.
 */
function buildNew(lines: string[], pos: number, o: string[], n: BodyLine[], ctx: Map<number, number>, tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(lines[pos]!);
    p = leadWs(o[0]!);
  }
  return n.map((bl, ni) => {
    const ci = ctx.get(ni);
    if (ci !== undefined) return lines[pos + ci]!;
    if (tier === 2 && bl.text !== '' && bl.text.trim() !== '' && bl.text.startsWith(p)) return f + bl.text.slice(p.length);
    return bl.text;
  });
}

/** Split a parsed body (context/old/new lines in order) into O, N and the context index map. */
function splitBody(body: BodyLine[]): { o: string[]; n: BodyLine[]; ctx: Map<number, number> } {
  const o: string[] = [];
  const n: BodyLine[] = [];
  const ctx = new Map<number, number>();
  for (const bl of body) {
    if (bl.t === ' ' || bl.t === '-') o.push(bl.text);
    if (bl.t === ' ' || bl.t === '+') {
      if (bl.t === ' ') ctx.set(n.length, o.length - 1);
      n.push(bl);
    }
  }
  return { o, n, ctx };
}

/* ---------------- format detection (SPEC.md section 4) ---------------- */

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

/* ---------------- JSON edits (SPEC.md section 9) ---------------- */

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
      const m = toModel(before);
      if (line < 0 || line > m.lines.length) throw new Fail('no-match', p);
      m.lines.splice(line, 0, ...add);
      tree.now.set(p, fromModel(m));
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

/* ---------------- unified diffs (SPEC.md section 6) ---------------- */

interface UHunk {
  a: number;
  body: BodyLine[];
  /** Indices of body lines a `\` line follows (that body line has no line break after it). */
  noEol: Set<number>;
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `--- `/`+++ ` line names: text after the four characters, to the first tab, spaces removed. */
function dashPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseHunk(lines: string[], i: number, sec: USection): number {
  const m = HUNK_RE.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const body: BodyLine[] = [];
  const fromEmpty: boolean[] = [];
  const noEol = new Set<number>();
  let j = i + 1;
  while (j < lines.length) {
    const bl = lines[j]!;
    if (bl.startsWith('diff --git ')) break;
    if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (bl === '') {
      body.push({ t: ' ', text: '' });
      fromEmpty.push(true);
      j += 1;
      continue;
    }
    const c = bl[0]!;
    if (c === ' ' || c === '-' || c === '+') {
      body.push({ t: c as BodyLine['t'], text: bl.slice(1) });
      fromEmpty.push(false);
      j += 1;
      continue;
    }
    if (c === '\\') {
      if (body.length > 0) noEol.add(body.length - 1);
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && fromEmpty[body.length - 1]) {
    body.pop();
    fromEmpty.pop();
  }
  sec.hunks.push({ a: Number(m[1]), body, noEol });
  return j;
}

/** Apply one section's hunks, in order, to a file model. Throws Fail('no-match', path). */
function applyHunks(model: Model, hunks: UHunk[], strict: boolean, path: string): Model {
  const lines = [...model.lines];
  let fin = model.final;
  let d = 0;
  for (const h of hunks) {
    const { o, n, ctx } = splitBody(h.body);
    if (o.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const atEnd = at === lines.length;
      const written = buildNew(lines, at, o, n, ctx, 0);
      lines.splice(at, 0, ...written);
      if (atEnd) {
        // insertion at the end: the final break follows the last `+` line's `\` marker
        let lastPlus = -1;
        h.body.forEach((bl, bi) => {
          if (bl.t === '+') lastPlus = bi;
        });
        if (lastPlus >= 0) fin = !h.noEol.has(lastPlus);
      }
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.at[0]!;
    for (const cand of found.at) {
      if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
    }
    const written = buildNew(lines, pos, o, n, ctx, found.tier);
    const endsAtEnd = pos + o.length === lines.length;
    lines.splice(pos, o.length, ...written);
    if (endsAtEnd) {
      let lastCtxPlus = -1;
      h.body.forEach((bl, bi) => {
        if (bl.t === ' ' || bl.t === '+') lastCtxPlus = bi;
      });
      fin = lastCtxPlus >= 0 ? !h.noEol.has(lastCtxPlus) : fin;
    }
    d += n.length - o.length;
  }
  return { br: model.br, lines, final: fin };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const newSection = (): USection => {
    const s: USection = { gitOld: null, gitNew: null, dashOld: undefined, dashNew: undefined, renFrom: null, renTo: null, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && cur.gitOld !== null && cur.dashOld === undefined) {
        cur.dashOld = dashPath(l);
        cur.dashNew = dashPath(lines[i + 1]!);
      } else {
        cur = newSection();
        cur.dashOld = dashPath(l);
        cur.dashNew = dashPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (cur.hunks.length > 0) {
      if (l.startsWith('@@')) {
        i = parseHunk(lines, i, cur);
        continue;
      }
      i += 1;
      continue;
    }
    // Section header, before its first hunk.
    if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (l.startsWith('rename from ')) {
      cur.renFrom = l.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      cur.renTo = l.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      cur.newFile = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      cur.delFile = true;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      i = parseHunk(lines, i, cur);
      continue;
    }
    i += 1;
  }

  return sections.map((sec): Edit => {
    const oldP = sec.dashOld !== undefined ? sec.dashOld : sec.renFrom ?? sec.gitOld;
    const newP = sec.dashNew !== undefined ? sec.dashNew : sec.renTo ?? sec.gitNew;
    const creation = sec.dashOld === null || sec.newFile;
    const deletion = !creation && (sec.dashNew === null || sec.delFile);
    return (tree) => {
      if (creation) {
        const p = newP ?? oldP ?? '';
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let lastPlusNoEol = false;
        for (const h of sec.hunks) {
          h.body.forEach((bl, bi) => {
            if (bl.t === '+') {
              plus.push(bl.text);
              lastPlusNoEol = h.noEol.has(bi);
            }
          });
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoEol ? '' : '\n'));
        return;
      }
      if (deletion) {
        const p = oldP ?? '';
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const o = oldP ?? '';
      const n = newP ?? o;
      if (!safe(o)) throw new Fail('unsafe', o);
      if (n !== o && !safe(n)) throw new Fail('unsafe', n);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (n !== o && tree.get(n) !== null) throw new Fail('exists', n);
      const after = applyHunks(toModel(before), sec.hunks, strict, o);
      if (n !== o) {
        tree.now.set(o, null);
        tree.now.set(n, fromModel(after));
        moves.push([o, n]);
      } else {
        tree.now.set(o, fromModel(after));
      }
    };
  });
}

/* ---------------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------------- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldL: string[];
    newL: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let eq = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${searchAt + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    blocks.push({ path, oldL: lines.slice(searchAt + 1, eq), newL: lines.slice(eq + 1, rep) });
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b): Edit => {
    return (tree) => {
      const p = b.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (b.oldL.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, b.newL.length === 0 ? '' : b.newL.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const m = toModel(before);
      const found = findTier(m.lines, b.oldL, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      const pos = found.at[0]!;
      const n: BodyLine[] = b.newL.map((text) => ({ t: '+' as const, text }));
      const written = buildNew(m.lines, pos, b.oldL, n, new Map(), found.tier);
      m.lines.splice(pos, b.oldL.length, ...written);
      tree.now.set(p, fromModel(m));
    };
  });
}

/* ---------------- V4A patches (SPEC.md section 8) ---------------- */

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  atLine: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

const VHEAD: Array<[string, VSection['kind']]> = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'del'],
  ['*** Update File: ', 'upd'],
];

function v4aSections(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const headAt = (idx: number): [VSection['kind'], string] | null => {
    for (const [pre, kind] of VHEAD) {
      if (lines[idx]!.startsWith(pre)) return [kind, lines[idx]!.slice(pre.length).trim()];
    }
    return null;
  };
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const head = headAt(i);
    if (head === null) throw new Exit2(`error: parse ${i + 1}`);
    const [kind, path] = head;
    const sec: VSection = { kind, path, atLine: i + 1, addLines: [], moveTo: null, chunks: [] };
    // Collect the section's raw lines (with their patch indices), to the next section or the end.
    const raw: Array<{ idx: number; text: string }> = [];
    let j = i + 1;
    while (j < last && headAt(j) === null) {
      raw.push({ idx: j, text: lines[j]! });
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else if (r.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
    } else if (kind === 'del') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.idx + 1}`);
      }
    } else {
      let k = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        sec.moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        k = 1;
      }
      let chunk: VChunk | null = null;
      for (; k < raw.length; k += 1) {
        const r = raw[k]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          chunk = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), body: [], eof: false };
          sec.chunks.push(chunk);
          continue;
        }
        if (t.trim() === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, body: [], eof: true };
            sec.chunks.push(chunk);
          } else chunk.eof = true;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (chunk === null) {
            chunk = { anchor: null, body: [], eof: false };
            sec.chunks.push(chunk);
          }
          chunk.body.push({ t: t === '' ? ' ' : (t[0] as BodyLine['t']), text: t === '' ? '' : t.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.atLine}`);
    }
    sections.push(sec);
    i = j;
  }
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return v4aSections(lines).map((sec): Edit => {
    return (tree) => {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (sec.kind === 'add') {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'del') {
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const target = sec.moveTo;
      if (target !== null && target !== p && !safe(target)) throw new Fail('unsafe', target);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (target !== null && target !== p && tree.get(target) !== null) throw new Fail('exists', target);
      const m = toModel(before);
      const ls = [...m.lines];
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          let hit = -1;
          for (let tier = 0; tier <= (strict ? 0 : 2) && hit < 0; tier += 1) {
            for (let k = cursor; k < ls.length; k += 1) {
              if (lineEq(tier, ls[k]!, ch.anchor)) {
                hit = k;
                break;
              }
            }
          }
          if (hit < 0) throw new Fail('no-match', p);
          cursor = hit + 1;
        }
        const { o, n, ctx } = splitBody(ch.body);
        if (o.length === 0) {
          const at = ch.eof ? ls.length : cursor;
          const written = buildNew(ls, at, o, n, ctx, 0);
          ls.splice(at, 0, ...written);
          cursor = at + written.length;
          continue;
        }
        let placed: { tier: number; pos: number } | null = null;
        for (let tier = 0; tier <= (strict ? 0 : 2) && placed === null; tier += 1) {
          const at = occurrences(ls, o, tier).filter((x) => x >= cursor && (!ch.eof || x + o.length === ls.length));
          if (at.length > 0) placed = { tier, pos: at[0]! };
        }
        if (placed === null) throw new Fail('no-match', p);
        const written = buildNew(ls, placed.pos, o, n, ctx, placed.tier);
        ls.splice(placed.pos, o.length, ...written);
        cursor = placed.pos + written.length;
      }
      const out = fromModel({ br: m.br, lines: ls, final: m.final });
      if (target !== null && target !== p) {
        tree.now.set(p, null);
        tree.now.set(target, out);
        moves.push([p, target]);
      } else {
        tree.now.set(p, out);
      }
    };
  });
}

/* ---------------- invocation, output and exit codes (SPEC.md sections 1, 2 and 10) ---------------- */

function run(args: string[]): { code: number; out: string[] } {
  moves.length = 0;
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths, with a successful move's D+A pair replaced by one R line (SPEC.md section 2).
  const changed = new Map<string, string | null>();
  for (const p of tree.now.keys()) {
    const now = tree.now.get(p)!;
    if (tree.original(p) !== now) changed.set(p, now);
  }
  const rows: Array<{ key: string; text: string }> = [];
  const covered = new Set<string>();
  for (const [o, n] of moves) {
    if (covered.has(o) || covered.has(n)) continue;
    const nowO = tree.now.has(o) ? tree.now.get(o)! : tree.original(o);
    const nowN = tree.now.has(n) ? tree.now.get(n)! : tree.original(n);
    if (tree.original(o) !== null && nowO === null && tree.original(n) === null && nowN !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      covered.add(o);
      covered.add(n);
    }
  }
  for (const [p, now] of changed) {
    if (covered.has(p)) continue;
    rows.push({ key: p, text: `${tree.original(p) === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const [p, now] of changed) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
