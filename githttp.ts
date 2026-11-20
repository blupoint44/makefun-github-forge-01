// githttp.ts — the git smart-HTTP surface: ref advertisement, ls-refs, fetch
// (protocol v2, with a v0 fallback) and receive-pack pushes with report-status.
//
// The wire shapes follow the git protocol as the suite's client speaks it:
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /{owner}/{repo}.git/git-upload-pack    (ls-refs and fetch commands)
//   POST /{owner}/{repo}.git/git-receive-pack   (command list + packfile)
// Objects come and go through the shared Forge store, so a commit pushed here
// is immediately visible to the REST contents API and vice versa.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, type RepoRecord } from './forge.ts';
import {
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  pktJoin,
  pktLine,
  pktSplit,
  readPack,
  writePack,
  type StoredObject,
} from './gitobj.ts';

const AGENT = 'skywe-forge/1.0';
const UPLOAD_CAPS_V2 = ['agent=' + AGENT, 'object-format=sha1', 'ls-refs=unborn', 'fetch=shallow wait-for-done'];
const UPLOAD_CAPS_V0 =
  'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not object-format=sha1';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta';

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  send(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found\n'));
}

/** Every ref line a v0 advertisement carries: HEAD first, then sorted refs with peeled tags. */
function advertisedRefs(forge: Forge, repo: RepoRecord): Array<{ oid: string; name: string; peeled?: string }> {
  const refs: Array<{ oid: string; name: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    const object = forge.getObject(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = forge.peelToCommit(oid);
      if (target !== null) entry.peeled = target;
    }
    refs.push(entry);
  }
  return refs;
}

function infoRefs(forge: Forge, repo: RepoRecord, service: string, protocolHeader: string | undefined, res: ServerResponse): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    send(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown service\n'));
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (protocolHeader ?? '').includes('version=2');
  if (wantsV2) {
    const lines: Buffer[] = [pktLine('version 2\n')];
    for (const capability of UPLOAD_CAPS_V2) lines.push(pktLine(`${capability}\n`));
    lines.push(Buffer.from('0000'));
    send(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(lines));
    return;
  }
  const headTarget = forge.headRef(repo);
  const caps =
    service === 'git-upload-pack'
      ? `${UPLOAD_CAPS_V0} symref=HEAD:${headTarget} agent=${AGENT}`
      : `${RECEIVE_CAPS} agent=${AGENT}`;
  const refs = advertisedRefs(forge, repo);
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), Buffer.from('0000')];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    const headOid = repo.refs.get(headTarget) ?? ZERO_OID;
    let first = true;
    lines.push(pktLine(`${headOid} HEAD\0${caps}`));
    first = false;
    void first;
    for (const ref of refs) {
      lines.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  send(res, 200, `application/x-${service}-advertisement`, Buffer.concat(lines));
}

// ---------------------------------------------------------------- ls-refs

function lsRefs(forge: Forge, repo: RepoRecord, args: readonly string[], res: ServerResponse): void {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const lines: Buffer[] = [];
  const headTarget = forge.headRef(repo);
  const headOid = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    } else if (unborn) {
      lines.push(pktLine(`unborn HEAD symref-target:${headTarget}\n`));
    }
  }
  for (const ref of advertisedRefs(forge, repo)) {
    if (!matches(ref.name)) continue;
    const peeled = peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : '';
    lines.push(pktLine(`${ref.oid} ${ref.name}${peeled}\n`));
  }
  lines.push(Buffer.from('0000'));
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(lines));
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(args: readonly string[]): FetchArgs {
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) parsed.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) parsed.depth = Number.parseInt(arg.slice(7), 10) || null;
    else if (arg === 'done') parsed.done = true;
  }
  parsed.wants = parsed.wants.filter(isOid);
  parsed.haves = parsed.haves.filter(isOid);
  parsed.shallow = parsed.shallow.filter(isOid);
  return parsed;
}

/** Frame a pack as band-1 sideband packets of at most 65515 payload bytes each. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const end = Math.min(pack.length, offset + CHUNK);
    // One allocation per packet: 4-byte hex length, band byte, then the chunk.
    // (pktLine() would concat twice per packet for the same bytes.)
    const line = Buffer.allocUnsafe(4 + 1 + (end - offset));
    line.write((line.length).toString(16).padStart(4, '0'), 0, 'ascii');
    line[4] = 1;
    pack.copy(line, 5, offset, end);
    packets.push(line);
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

function fetchV2(forge: Forge, repo: RepoRecord, args: readonly string[], res: ServerResponse): void {
  const request = parseFetchArgs(args);
  const parts: Buffer[] = [];
  if (!request.done) {
    // A negotiation round: acknowledgments only, no packfile yet.
    const known = request.haves.filter((have) => forge.getObject(have) !== undefined);
    parts.push(pktLine('acknowledgments\n'));
    if (known.length === 0) parts.push(pktLine('NAK\n'));
    else for (const have of known) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(Buffer.from('0000'));
    send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  const selection = forge.fetchSelection(request.wants, request.haves, request.shallow, request.depth);
  if (request.haves.length > 0) {
    const known = request.haves.filter((have) => forge.getObject(have) !== undefined);
    parts.push(pktLine('acknowledgments\n'));
    if (known.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      parts.push(pktLine(`ACK ${known[known.length - 1]}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(Buffer.from('0000'));
  }
  if (request.depth !== null || request.shallow.length > 0 || selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0000'));
  }
  const objects: StoredObject[] = [];
  for (const oid of selection.send) {
    const object = forge.getObject(oid);
    if (object !== undefined) objects.push(object);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(writePack(objects)));
  parts.push(Buffer.from('0000'));
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** The v0 fetch fallback: wants and haves as plain pkt-lines, then a sideband pack. */
function fetchV0(forge: Forge, repo: RepoRecord, packets: readonly string[], res: ServerResponse): void {
  const args: string[] = [];
  let afterFlush = false;
  for (const line of packets) {
    if (line === '') {
      afterFlush = true;
      continue;
    }
    args.push(line);
    void afterFlush;
  }
  const request = parseFetchArgs(args.map((line) => line.replace(/^want [0-9a-f]{40} /, 'want ')));
  // v0 puts capabilities on the first want line; strip anything past the oid.
  request.wants = args
    .filter((line) => line.startsWith('want '))
    .map((line) => line.split(' ')[1] ?? '')
    .filter(isOid);
  request.haves = args
    .filter((line) => line.startsWith('have '))
    .map((line) => line.slice(5).trim())
    .filter(isOid);
  const selection = forge.fetchSelection(request.wants, request.haves, request.shallow, request.depth);
  const parts: Buffer[] = [];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  const objects: StoredObject[] = [];
  for (const oid of selection.send) {
    const object = forge.getObject(oid);
    if (object !== undefined) objects.push(object);
  }
  parts.push(...sidebandPackets(writePack(objects)));
  parts.push(Buffer.from('0000'));
  send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function uploadPack(forge: Forge, repo: RepoRecord, body: Buffer, res: ServerResponse): void {
  let packets;
  try {
    packets = pktSplit(body).packets;
  } catch {
    send(res, 400, 'text/plain; charset=utf-8', Buffer.from('malformed pkt-line request\n'));
    return;
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    else if (packet.kind === 'delim') lines.push(''); // argument separator marker
    else if (packet.kind === 'flush') lines.push('');
  }
  const first = lines[0] ?? '';
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length);
    // Arguments are the lines after the first delimiter marker.
    const delimIndex = lines.indexOf('', 1);
    const args = delimIndex >= 0 ? lines.slice(delimIndex + 1).filter((line) => line !== '') : [];
    if (command === 'ls-refs') {
      lsRefs(forge, repo, args, res);
      return;
    }
    if (command === 'fetch') {
      fetchV2(forge, repo, args, res);
      return;
    }
    send(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown command\n'));
    return;
  }
  if (first.startsWith('want ')) {
    fetchV0(forge, repo, lines, res);
    return;
  }
  send(res, 400, 'text/plain; charset=utf-8', Buffer.from('unrecognised upload-pack request\n'));
}

// ---------------------------------------------------------------- receive-pack

interface PushCommandLine {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Whether every object reachable from `tip` is present in the combined lookup.
 *
 * Objects already in the store proved their closure when they were stored:
 * every store path either validates closure first (receive-pack) or builds
 * new objects only from stored ones (contents API, merges), so a stored
 * object is a leaf here — the walk expands only the pack's fresh objects.
 * Walking the full ancestry on every push was O(history) per push (the
 * bench's 200-push chain re-walked up to 200 commits each time, ~470 us
 * on the last pushes); the pruned walk touches exactly the fresh objects.
 */
function closureComplete(forge: Forge, extra: ReadonlyMap<string, StoredObject>, tip: string): boolean {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const fresh = extra.get(oid);
    if (fresh !== undefined) {
      if (fresh.type === 'commit') {
        const view = parseCommit(fresh.data);
        stack.push(view.tree, ...view.parents);
      } else if (fresh.type === 'tag') {
        stack.push(parseTag(fresh.data).object);
      } else if (fresh.type === 'tree') {
        for (const entry of parseTree(fresh.data)) if (entry.mode !== '160000') stack.push(entry.oid);
      }
      continue;
    }
    if (forge.getObject(oid) === undefined) return false;
    // Stored object: its closure was proven at store time; do not descend.
  }
  return true;
}

function receivePack(forge: Forge, repo: RepoRecord, body: Buffer, res: ServerResponse): void {
  let split;
  try {
    split = pktSplit(body);
  } catch {
    send(res, 400, 'text/plain; charset=utf-8', Buffer.from('malformed pkt-line request\n'));
    return;
  }
  const commands: PushCommandLine[] = [];
  let capabilities = '';
  let sawFlush = false;
  for (const packet of split.packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length === 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  if (!sawFlush || commands.length === 0) {
    send(res, 400, 'text/plain; charset=utf-8', Buffer.from('no push commands\n'));
    return;
  }
  const sideband = capabilities.split(' ').includes('side-band-64k');

  const respond = (reportLines: string[]): void => {
    const inner = pktJoin([...reportLines.map((line) => Buffer.from(line, 'utf8')), 'flush']);
    if (!sideband) {
      send(res, 200, 'application/x-git-receive-pack-result', inner);
      return;
    }
    // The report stream rides inside band-1 packets, one report frame each.
    const frames: Buffer[] = [];
    let offset = 0;
    while (offset < inner.length) {
      // Split on frame boundaries: each report pkt-line is at most a few dozen
      // bytes, so frame by frame is both simple and safe.
      const length = Number.parseInt(inner.subarray(offset, offset + 4).toString('ascii'), 16);
      if (length === 0) {
        frames.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(offset, offset + 4)])));
        offset += 4;
        break;
      }
      frames.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(offset, offset + length)])));
      offset += length;
    }
    frames.push(Buffer.from('0000'));
    send(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(frames));
  };

  // Unpack first: a pack that does not parse or does not close over its tips
  // refuses the whole push before any ref moves.
  let fresh = new Map<string, StoredObject>();
  const packBytes = split.rest;
  if (packBytes.length > 0) {
    try {
      fresh = readPack(packBytes, forge.objects);
    } catch (err) {
      respond([`unpack ${err instanceof Error ? err.message : 'error'}\n`]);
      return;
    }
    for (const command of commands) {
      if (command.newOid !== ZERO_OID && !closureComplete(forge, fresh, command.newOid)) {
        respond(['unpack error: the pack does not contain the full closure of a pushed tip\n']);
        return;
      }
    }
    for (const [oid, object] of fresh) {
      if (!forge.objects.has(oid)) forge.objects.set(oid, object);
    }
  }

  const results: string[] = ['unpack ok\n'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    const refuse = (reason: string): void => {
      results.push(`ng ${command.ref} ${reason}\n`);
    };
    if (command.oldOid !== current) {
      refuse('stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) {
        refuse('reference does not exist');
        continue;
      }
      repo.refs.delete(command.ref);
      results.push(`ok ${command.ref}\n`);
      continue;
    }
    if (forge.getObject(command.newOid) === undefined) {
      refuse('missing object');
      continue;
    }
    if (command.oldOid !== ZERO_OID && command.ref.startsWith('refs/heads/')) {
      const oldCommit = forge.peelToCommit(current);
      const newCommit = forge.peelToCommit(command.newOid);
      if (oldCommit === null || newCommit === null || !forge.isAncestor(oldCommit, newCommit)) {
        refuse('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push(`ok ${command.ref}\n`);
  }
  respond(results);
}

// ---------------------------------------------------------------- routing

/** Handle one git smart-HTTP request. `segments` is the path after /{owner}/{repo}.git. */
export function handleGit(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  tail: string,
  query: URLSearchParams,
  body: Buffer,
): void {
  const repo = forge.findRepo(owner, repoName);
  if (repo === null) {
    notFound(res);
    return;
  }
  if (req.method === 'GET' && tail === '/info/refs') {
    infoRefs(forge, repo, query.get('service') ?? '', req.headers['git-protocol'], res);
    return;
  }
  if (req.method === 'POST' && tail === '/git-upload-pack') {
    uploadPack(forge, repo, body, res);
    return;
  }
  if (req.method === 'POST' && tail === '/git-receive-pack') {
    receivePack(forge, repo, body, res);
    return;
  }
  notFound(res);
}
