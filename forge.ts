// forge.ts — the forge's store and domain logic, shared by every surface
// (git smart HTTP, REST v3, GraphQL and MCP all read and write through here,
// so an object created on one surface is the same object on all the others).
//
// State is in memory: a content-addressed object store (one per forge, like a
// shared object database), and per-repository records holding refs, labels,
// issues, pull requests and comments. Numbers and ids come from counters, and
// commit timestamps from a logical clock, so behaviour is deterministic.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  type ObjectType,
  type StoredObject,
  type TreeEntry,
} from './gitobj.ts';

/** The one identity the trial's token belongs to (wire.ts's seeded viewer). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const DEFAULT_BRANCH = 'main';
const EPOCH_START = 1_735_689_600; // the scenario's day one, 2025-01-01T00:00:00Z

export interface LabelRecord {
  name: string;
  color: string;
}

export interface CommentRecord {
  id: number;
  body: string;
}

export interface IssueRecord {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRecord[];
}

export interface PullRecord {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** The base branch tip when the pull request was opened (its branch point). */
  baseSha: string;
  headSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface RepoRecord {
  dbId: number;
  name: string;
  ownerLogin: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  /** Full ref name (refs/heads/x, refs/tags/x) to object id. */
  refs: Map<string, string>;
  labels: Map<string, LabelRecord>;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
}

export class ForgeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Forge {
  readonly objects = new Map<string, StoredObject>();
  readonly repos = new Map<string, RepoRecord>();
  private nextRepoDbId = 1;
  private nextObjectId = 1;
  private nextCommentId = 1;
  private clockTick = 0;

  /** A deterministic timestamp for a new commit, seconds since the epoch. */
  nextTimestamp(): number {
    this.clockTick += 1;
    return EPOCH_START + this.clockTick;
  }

  isoOf(epochSec: number): string {
    return new Date(epochSec * 1000).toISOString();
  }

  private identity(epochSec: number): string {
    return `${VIEWER.name} <${VIEWER.email}> ${epochSec} +0000`;
  }

  // -------------------------------------------------------------- objects

  putObject(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): StoredObject | undefined {
    return this.objects.get(oid);
  }

  /** Follow tag objects to the commit they name; a commit peels to itself. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** The commit ids reachable from `tip`, tip first, parents in order. */
  ancestry(tip: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      order.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let index = parents.length - 1; index >= 0; index -= 1) stack.push(parents[index]);
    }
    return order;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const object = this.objects.get(descendant);
    if (object === undefined || object.type !== 'commit') return false;
    if (parseCommit(object.data).parents.includes(ancestor)) return true;
    return new Set(this.ancestry(descendant)).has(ancestor);
  }

  /** The deepest common ancestor of two commits, or null when unrelated. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOfA = new Set(this.ancestry(a));
    for (const candidate of this.ancestry(b)) {
      if (ancestorsOfA.has(candidate)) return candidate;
    }
    return null;
  }

  /** Every object reachable from the given tips (commits, tags, trees, blobs). */
  reachable(tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree, ...commit.parents);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /**
   * The objects a fetch must carry: what is reachable from `wants` (bounded to
   * `depth` commit generations when depth is set), minus what the client's
   * haves already cover (a have named in `shallowBoundary` covers only itself
   * and its tree, not its parents). Also answers the new shallow boundary.
   */
  fetchSelection(
    wants: readonly string[],
    haves: readonly string[],
    shallowBoundary: readonly string[],
    depth: number | null,
  ): { send: string[]; shallow: string[]; unshallow: string[] } {
    // Commits the client provably holds, with their trees and blobs.
    const held = new Set<string>();
    const shallowSet = new Set(shallowBoundary);
    for (const have of haves) {
      const object = this.objects.get(have);
      if (object === undefined) continue;
      if (object.type === 'commit' && shallowSet.has(have)) {
        held.add(have);
        const tree = parseCommit(object.data).tree;
        for (const oid of this.reachable([tree])) held.add(oid);
      } else {
        for (const oid of this.reachable([have])) held.add(oid);
      }
    }

    // The wanted closure, generation by generation when a depth is set.
    const wanted = new Set<string>();
    const boundary: string[] = [];
    const includeClosure = (root: string): void => {
      for (const oid of this.reachable([root])) wanted.add(oid);
    };
    if (depth === null) {
      for (const want of wants) includeClosure(want);
    } else {
      // Breadth-first over commits: generation 0 is the wants themselves.
      let frontier: string[] = [];
      const seenCommits = new Set<string>();
      for (const want of wants) {
        const commit = this.peelToCommit(want);
        if (commit === null) {
          includeClosure(want);
          continue;
        }
        if (!seenCommits.has(commit)) {
          seenCommits.add(commit);
          frontier.push(commit);
        }
        if (want !== commit) includeClosure(want); // a tag object rides along
      }
      for (let generation = 0; generation < depth; generation += 1) {
        const next: string[] = [];
        for (const commit of frontier) {
          const view = parseCommit(this.objects.get(commit)!.data);
          for (const oid of this.reachable([view.tree])) wanted.add(oid);
          wanted.add(commit);
          const parents = view.parents.filter((parent) => this.objects.has(parent));
          if (generation === depth - 1) {
            if (parents.length > 0) boundary.push(commit);
          } else {
            for (const parent of parents) {
              if (!seenCommits.has(parent)) {
                seenCommits.add(parent);
                next.push(parent);
              }
            }
          }
        }
        frontier = next;
      }
    }

    const send = [...wanted].filter((oid) => !held.has(oid));
    const unshallow: string[] = [];
    for (const oid of shallowBoundary) {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((parent) => wanted.has(parent)) && wanted.has(oid)) unshallow.push(oid);
    }
    return { send, shallow: boundary.filter((oid) => !unshallow.includes(oid)), unshallow };
  }

  // -------------------------------------------------------------- trees as file maps

  /** Flatten a tree object into path -> {oid, mode}; empty map for a null tree. */
  flattenTree(treeOid: string | null): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (treeOid === null) return out;
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) the nested trees for a flat path -> blob map; returns the root tree id. */
  buildTreeFromFiles(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index];
        if (!node.dirs.has(name)) node.dirs.set(name, { files: new Map(), dirs: new Map() });
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1], file);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  treeOfCommit(commitOid: string): string | null {
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** One commit on top of `parent` (or a root commit) holding `files`. */
  commitFiles(parent: string | null, files: ReadonlyMap<string, { oid: string; mode: string }>, message: string): string {
    const tree = this.buildTreeFromFiles(files);
    const stamp = this.nextTimestamp();
    const identity = this.identity(stamp);
    const data = buildCommit({
      tree,
      parents: parent === null ? [] : [parent],
      author: identity,
      committer: identity,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    return this.putObject('commit', data);
  }

  // -------------------------------------------------------------- repositories

  createRepo(name: string, options: { isPrivate?: boolean; description?: string } = {}): RepoRecord {
    if (this.repos.has(name)) {
      throw new ForgeError(422, 'Repository creation failed: name already exists on this account');
    }
    const repo: RepoRecord = {
      dbId: this.nextRepoDbId++,
      name,
      ownerLogin: VIEWER.login,
      isPrivate: options.isPrivate ?? false,
      description: options.description ?? '',
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** Resolve a repository by the owner/name pair a surface addressed; a wrong owner is a miss. */
  findRepo(owner: string, name: string): RepoRecord | null {
    const repo = this.repos.get(name);
    if (repo === undefined || repo.ownerLogin !== owner) return null;
    return repo;
  }

  repoByDbId(dbId: number): RepoRecord | null {
    for (const repo of this.repos.values()) if (repo.dbId === dbId) return repo;
    return null;
  }

  deleteRepo(repo: RepoRecord): void {
    this.repos.delete(repo.name);
  }

  viewerRepos(): RepoRecord[] {
    return [...this.repos.values()].sort((a, b) => a.dbId - b.dbId);
  }

  headRef(repo: RepoRecord): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  branchTip(repo: RepoRecord, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  // -------------------------------------------------------------- contents API

  /**
   * Write one file on a branch (the default branch when unnamed), creating the
   * branch from the default tip when it does not exist yet and the first
   * commit when the repository is unborn. Returns the commit and blob ids and
   * whether the file was created (201) or updated (200).
   */
  putContent(
    repo: RepoRecord,
    path: string,
    content: Buffer,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { commitSha: string; blobSha: string; created: boolean } {
    const branchName = branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branchName}`;
    let tip = repo.refs.get(ref) ?? null;
    if (tip === null && branch !== undefined && branch !== repo.defaultBranch) {
      tip = repo.refs.get(this.headRef(repo)) ?? null;
    }
    const tipCommit = tip === null ? null : this.peelToCommit(tip);
    const files = this.flattenTree(tipCommit === null ? null : this.treeOfCommit(tipCommit));
    const existing = files.get(path);
    if (sha !== undefined) {
      if (existing === undefined) throw new ForgeError(422, `sha supplied for ${path}, but the file does not exist`);
      if (existing.oid !== sha) throw new ForgeError(409, `${path} does not match the supplied sha`);
    }
    const blobSha = this.putObject('blob', content);
    files.set(path, { oid: blobSha, mode: existing?.mode ?? '100644' });
    const commitSha = this.commitFiles(tipCommit, files, message);
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha, created: existing === undefined };
  }

  /** Delete one file on a branch with a commit; answers the commit id. */
  deleteContent(repo: RepoRecord, path: string, message: string, branch: string | undefined, sha: string | undefined): string {
    const branchName = branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branchName}`;
    const tip = repo.refs.get(ref) ?? null;
    const tipCommit = tip === null ? null : this.peelToCommit(tip);
    if (tipCommit === null) throw new ForgeError(404, 'Not Found');
    const files = this.flattenTree(this.treeOfCommit(tipCommit));
    const existing = files.get(path);
    if (existing === undefined) throw new ForgeError(404, 'Not Found');
    if (sha !== undefined && existing.oid !== sha) throw new ForgeError(409, `${path} does not match the supplied sha`);
    files.delete(path);
    const commitSha = this.commitFiles(tipCommit, files, message);
    repo.refs.set(ref, commitSha);
    return commitSha;
  }

  /** Read a path at a ref: a file, a directory listing, or null when absent. */
  readContent(
    repo: RepoRecord,
    path: string,
    refName: string | undefined,
  ): { kind: 'file'; entry: { oid: string; mode: string } } | { kind: 'dir'; treeOid: string } | null {
    const commit = this.resolveCommit(repo, refName);
    if (commit === null) return path === '' ? { kind: 'dir', treeOid: this.putObject('tree', buildTree([])) } : null;
    let treeOid = this.treeOfCommit(commit);
    if (treeOid === null) return null;
    if (path === '') return { kind: 'dir', treeOid };
    const segments = path.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      const object = this.objects.get(treeOid);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return null;
      if (index === segments.length - 1) {
        if (entry.mode === '40000') return { kind: 'dir', treeOid: entry.oid };
        return { kind: 'file', entry: { oid: entry.oid, mode: entry.mode } };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  /** A ref name (branch, tag or full ref) or a commit id to a commit id. */
  resolveCommit(repo: RepoRecord, refName: string | undefined): string | null {
    if (refName === undefined || refName === '') {
      const tip = repo.refs.get(this.headRef(repo));
      return tip === undefined ? null : this.peelToCommit(tip);
    }
    const candidates = [
      repo.refs.get(refName),
      repo.refs.get(`refs/heads/${refName}`),
      repo.refs.get(`refs/tags/${refName}`),
    ];
    for (const candidate of candidates) {
      if (candidate !== undefined) return this.peelToCommit(candidate);
    }
    if (isOid(refName)) {
      const object = this.objects.get(refName);
      if (object !== undefined) return this.peelToCommit(refName);
    }
    return null;
  }

  // -------------------------------------------------------------- issues

  createIssue(repo: RepoRecord, title: string, body: string, labelNames: readonly string[]): IssueRecord {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) throw new ForgeError(422, `Label "${name}" does not exist in this repository`);
    }
    const issue: IssueRecord = {
      number: repo.nextNumber++,
      id: this.nextObjectId++,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(issue: IssueRecord, body: string): CommentRecord {
    const comment: CommentRecord = { id: this.nextCommentId++, body };
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------- pull requests

  createPull(repo: RepoRecord, title: string, body: string, headRef: string, baseRef: string): PullRecord {
    const headSha = this.branchTip(repo, headRef);
    if (headSha === null) throw new ForgeError(422, `Head ref ${headRef} does not exist`);
    const baseSha = this.branchTip(repo, baseRef);
    if (baseSha === null) throw new ForgeError(422, `Base ref ${baseRef} does not exist`);
    if (headSha === baseSha) throw new ForgeError(422, 'No commits between base and head');
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) {
        throw new ForgeError(422, 'A pull request already exists for this head and base');
      }
    }
    const pull: PullRecord = {
      number: repo.nextNumber++,
      id: this.nextObjectId++,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      baseSha,
      headSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The files a pull request changes: branch point (merge base) to head tip. */
  pullFiles(repo: RepoRecord, pull: PullRecord): Array<{ path: string; status: 'added' | 'removed' | 'modified'; before: Buffer | null; after: Buffer | null }> {
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const point = this.mergeBase(baseTip, headTip) ?? pull.baseSha;
    const beforeFiles = this.flattenTree(this.treeOfCommit(point));
    const afterFiles = this.flattenTree(this.treeOfCommit(headTip));
    const changes: Array<{ path: string; status: 'added' | 'removed' | 'modified'; before: Buffer | null; after: Buffer | null }> = [];
    const paths = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
    for (const path of [...paths].sort()) {
      const before = beforeFiles.get(path);
      const after = afterFiles.get(path);
      if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
      changes.push({
        path,
        status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
        before: before === undefined ? null : this.objects.get(before.oid)?.data ?? null,
        after: after === undefined ? null : this.objects.get(after.oid)?.data ?? null,
      });
    }
    return changes;
  }

  /**
   * A file-level three-way merge of the pull request into its base branch's
   * current tip. Answers the merged tree's file map, or null on a conflict:
   * a path the head changed whose current base content is neither the branch
   * point's content nor the head's content cannot be merged.
   */
  planMerge(repo: RepoRecord, pull: PullRecord): Map<string, { oid: string; mode: string }> | null {
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const point = this.mergeBase(baseTip, headTip) ?? pull.baseSha;
    const pointFiles = this.flattenTree(this.treeOfCommit(point));
    const headFiles = this.flattenTree(this.treeOfCommit(headTip));
    const baseFiles = this.flattenTree(this.treeOfCommit(baseTip));
    const merged = new Map(baseFiles);
    const paths = new Set([...pointFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const atPoint = pointFiles.get(path);
      const atHead = headFiles.get(path);
      if (atPoint !== undefined && atHead !== undefined && atPoint.oid === atHead.oid) continue;
      if (atPoint === undefined && atHead === undefined) continue;
      const atBase = baseFiles.get(path);
      const baseUnchanged = (atBase?.oid ?? null) === (atPoint?.oid ?? null);
      const baseMatchesHead = (atBase?.oid ?? null) === (atHead?.oid ?? null);
      if (!baseUnchanged && !baseMatchesHead) return null;
      if (atHead === undefined) merged.delete(path);
      else merged.set(path, atHead);
    }
    return merged;
  }

  mergeableState(repo: RepoRecord, pull: PullRecord): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    return this.planMerge(repo, pull) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Squash-merge a pull request into its base branch; null when it conflicts. */
  squashMerge(repo: RepoRecord, pull: PullRecord): string | null {
    const plan = this.planMerge(repo, pull);
    if (plan === null) return null;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const baseCommit = this.peelToCommit(baseTip);
    const message = `${pull.title} (#${pull.number})`;
    const commitSha = this.commitFiles(baseCommit, plan, message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = commitSha;
    pull.mergedAt = this.isoOf(this.nextTimestamp());
    return commitSha;
  }
}
