// gitobj.ts — the git object model: SHA-1 ids, trees, commits, tags, packfiles.
//
// Everything here is byte-level git: an object's id is the SHA-1 of
// "<type> <length>\0" followed by its raw bytes, trees sort their entries the
// way git sorts them (a directory compares as if its name ended in '/'), and a
// packfile is the version-2 format of header, entries and a SHA-1 trailer.
// Only Node's standard library is used (node:crypto for hashing, node:zlib for
// the deflate streams inside packs).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface StoredObject {
  type: ObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const TYPE_TO_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export const OID_PATTERN = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_PATTERN.test(value);
}

/** The object id git assigns to a body: SHA-1 over the loose-object framing. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry is missing its mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialise entries into a tree object, sorted by git's tree ordering. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = Buffer.from(treeSortKey(a), 'utf8');
    const kb = Buffer.from(treeSortKey(b), 'utf8');
    return Buffer.compare(ka, kb);
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const header = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const header = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const view: TagView = { object: '', type: '', tag: '' };
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    if (key === 'object') view.object = line.slice(space + 1);
    else if (key === 'type') view.type = line.slice(space + 1);
    else if (key === 'tag') view.tag = line.slice(space + 1);
  }
  return view;
}

// ---------------------------------------------------------------- packfiles

function packEntryHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_TO_CODE[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a version-2 pack holding the given objects as plain (undeltified) entries. */
export function writePack(objects: readonly StoredObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Inflate the zlib stream starting at `offset`; answers the bytes and the offset just past it. */
function inflateEntry(pack: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine.bytesWritten) throw new Error('a pack entry inflated to nothing');
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta body to the base it was computed against. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset |= delta[offset++] << (8 * bit);
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) copySize |= delta[offset++] << (8 * bit);
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const count = op & 0x7f;
      delta.copy(out, written, offset, offset + count);
      offset += count;
      written += count;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

export interface ParsedPack {
  objects: Map<string, StoredObject>;
  count: number;
}

/**
 * Read a packfile into fully resolved objects. OFS and REF deltas are applied
 * against bases found in the pack itself or, for a thin pack, in `extraBases`.
 */
export function readPack(pack: Buffer, extraBases?: ReadonlyMap<string, StoredObject>): Map<string, StoredObject> {
  if (pack.length < 12 + 20) throw new Error('pack is shorter than its header and trailer');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const declared = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  if (sha1Hex(pack.subarray(0, pack.length - 20)) !== trailer) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    kind: 'plain' | 'ofs' | 'ref';
    type: ObjectType;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  const end = pack.length - 20;
  while (offset < end) {
    const entryOffset = offset;
    let byte = pack[offset++];
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (code === 6) {
      // OFS_DELTA: a negative offset to the base entry, encoded one's-complement style.
      let b = pack[offset++];
      let baseDistance = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++];
        baseDistance = ((baseDistance + 1) << 7) | (b & 0x7f);
      }
      const { data, next } = inflateEntry(pack, offset);
      offset = next;
      const entry: RawEntry = { offset: entryOffset, kind: 'ofs', type: 'blob', data, baseOffset: entryOffset - baseDistance };
      raw.push(entry);
      byOffset.set(entryOffset, entry);
    } else if (code === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data, next } = inflateEntry(pack, offset);
      offset = next;
      const entry: RawEntry = { offset: entryOffset, kind: 'ref', type: 'blob', data, baseOid };
      raw.push(entry);
      byOffset.set(entryOffset, entry);
    } else {
      const type = CODE_TO_TYPE[code];
      if (type === undefined) throw new Error(`pack entry type code ${code} is unknown`);
      const { data, next } = inflateEntry(pack, offset);
      offset = next;
      if (data.length !== size) throw new Error('pack entry size mismatch');
      const entry: RawEntry = { offset: entryOffset, kind: 'plain', type, data };
      raw.push(entry);
      byOffset.set(entryOffset, entry);
    }
  }
  if (raw.length !== declared) throw new Error(`pack declares ${declared} objects but holds ${raw.length}`);

  const resolved = new Map<string, StoredObject>();
  const resolve = (entry: RawEntry): StoredObject => {
    if (entry.kind === 'plain') return { type: entry.type, data: entry.data };
    let base: StoredObject | undefined;
    if (entry.kind === 'ofs') {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      base = resolve(baseEntry);
    } else {
      const inPack = raw.find((candidate) => candidate.kind === 'plain' && hashObject(candidate.type, candidate.data) === entry.baseOid);
      if (inPack !== undefined) base = resolve(inPack);
      else base = extraBases?.get(entry.baseOid ?? '');
      if (base === undefined) throw new Error('ref-delta base is not available');
    }
    return { type: base.type, data: applyDelta(base.data, entry.data) };
  };
  for (const entry of raw) {
    const object = resolve(entry);
    resolved.set(hashObject(object.type, object.data), object);
  }
  return resolved;
}

// ---------------------------------------------------------------- pkt-line framing

export const PKT_MAX_PAYLOAD = 65520 - 4;

/** Frame one payload as a pkt-line. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line payload too large');
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktItem = Buffer | 'flush' | 'delim';

export function pktJoin(items: readonly PktItem[]): Buffer {
  return Buffer.concat(items.map((item) => (item === 'flush' ? PKT_FLUSH : item === 'delim' ? PKT_DELIM : pktLine(item))));
}

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/**
 * Split a buffer into pkt-line packets plus whatever raw bytes trail the last
 * flush (a receive-pack body is framed commands followed by an unframed pack).
 * Throws on a malformed frame.
 */
export function pktSplit(buffer: Buffer): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > buffer.length) break;
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      // A flush ends the framed part when raw bytes follow that are not frames.
      const next = buffer.subarray(offset, offset + 4).toString('ascii');
      if (offset < buffer.length && !/^[0-9a-fA-F]{4}$/.test(next)) break;
      if (offset < buffer.length) {
        // Peek: a pack starts with 'PACK'; anything else continues the frames.
        if (buffer.subarray(offset, offset + 4).toString('ascii') === 'PACK') break;
      }
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > 65520) throw new Error(`pkt-line length ${length} is invalid`);
    if (offset + length > buffer.length) throw new Error('pkt-line is truncated');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}
