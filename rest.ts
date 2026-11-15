// rest.ts — the GitHub REST v3 surface under /api/v3.
//
// Routes: the API root and meta, the viewer, repository CRUD with Link-header
// pagination, branches and commits, the Git Data refs endpoints, the contents
// API (which writes real git commits into the shared store), labels, issues
// with comments, and pull requests with files and squash merges. Every reply
// is JSON with a {message} error body, matching the suite's contract.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, ForgeError, VIEWER, type IssueRecord, type PullRecord, type RepoRecord } from './forge.ts';
import { parseCommit, parseTree } from './gitobj.ts';

type Json = Record<string, unknown>;

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function fail(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

// ---------------------------------------------------------------- shapes

export function repoJson(repo: RepoRecord): Json {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.ownerLogin}/${repo.name}`,
    owner: { login: repo.ownerLogin, id: VIEWER.id },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
  };
}

export function issueJson(repo: RepoRecord, issue: IssueRecord): Json {
  void repo;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    comments: issue.comments.length,
    user: { login: VIEWER.login, id: VIEWER.id },
  };
}

export function commentJson(comment: { id: number; body: string }): Json {
  return { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id } };
}

export function pullJson(forge: Forge, repo: RepoRecord, pull: PullRecord): Json {
  const headSha = forge.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.ownerLogin}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.ownerLogin}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? forge.mergeableState(repo, pull) === 'MERGEABLE' : null,
    user: { login: VIEWER.login, id: VIEWER.id },
  };
}

function countLines(data: Buffer | null): number {
  if (data === null || data.length === 0) return 0;
  const lines = data.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

// ---------------------------------------------------------------- helpers

function bodyObject(body: unknown): Json {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Json) : {};
}

function stringField(body: Json, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

// ---------------------------------------------------------------- handler

export interface RestContext {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  /** Path segments after /api/v3, percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body (undefined when there was none). */
  body: unknown;
  /** True when a body was present but did not parse as JSON. */
  badJson: boolean;
}

export function handleRest(ctx: RestContext): void {
  const { forge, req, res, segments, query } = ctx;
  const method = req.method ?? 'GET';
  try {
    if (ctx.badJson && method !== 'GET' && method !== 'DELETE') {
      fail(res, 400, 'Invalid JSON body');
      return;
    }
    route(ctx);
  } catch (err) {
    if (err instanceof ForgeError) {
      fail(res, err.status, err.message);
      return;
    }
    throw err;
  }
  void method;
  void forge;
  void query;
}

function route(ctx: RestContext): void {
  const { forge, req, res, segments, query, body } = ctx;
  const method = req.method ?? 'GET';
  const data = bodyObject(body);

  // The API root and meta.
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        { current_user_url: '/api/v3/user', user_repositories_url: '/api/v3/user/repos', repository_url: '/api/v3/repos/{owner}/{repo}' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') sendJson(res, 200, { installed_version: '1.0.0', hooks: [], git: [] });
    else fail(res, 404, 'Not Found');
    return;
  }

  // The viewer.
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    else fail(res, 404, 'Not Found');
    return;
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') {
      const name = stringField(data, 'name');
      if (name === undefined || name === '') {
        fail(res, 422, 'Repository creation failed: name is required');
        return;
      }
      const repo = forge.createRepo(name, {
        isPrivate: data.private === true,
        description: stringField(data, 'description') ?? '',
      });
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const { page, perPage } = pageParams(query);
      const all = forge.viewerRepos();
      const start = (page - 1) * perPage;
      const items = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      const host = ctx.req.headers.host ?? 'localhost';
      const pageUrl = (p: number): string => `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${p}`;
      const lastPage = Math.max(1, Math.ceil(all.length / perPage));
      const links: string[] = [];
      if (page < lastPage) links.push(`<${pageUrl(page + 1)}>; rel="next"`, `<${pageUrl(lastPage)}>; rel="last"`);
      if (page > 1) links.push(`<${pageUrl(1)}>; rel="first"`, `<${pageUrl(page - 1)}>; rel="prev"`);
      if (links.length > 0) headers.link = links.join(', ');
      sendJson(res, 200, items.map(repoJson), headers);
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }

  if (segments[0] !== 'repos' || segments.length < 3) {
    fail(res, 404, 'Not Found');
    return;
  }
  const owner = segments[1];
  const repoName = segments[2];
  const repo = forge.findRepo(owner, repoName);
  if (repo === null) {
    fail(res, 404, 'Not Found');
    return;
  }
  const rest = segments.slice(3);

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const description = stringField(data, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof data.private === 'boolean') repo.isPrivate = data.private;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      sendJson(res, 204, null);
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }

  if (rest[0] === 'branches') return branchesRoute(ctx, repo, rest.slice(1));
  if (rest[0] === 'commits') return commitsRoute(ctx, repo, rest.slice(1));
  if (rest[0] === 'git' && rest[1] === 'refs') return gitRefsRoute(ctx, repo, rest.slice(2));
  if (rest[0] === 'contents') return contentsRoute(ctx, repo, rest.slice(1).join('/'));
  if (rest[0] === 'labels') return labelsRoute(ctx, repo, rest.slice(1));
  if (rest[0] === 'issues') return issuesRoute(ctx, repo, rest.slice(1));
  if (rest[0] === 'pulls') return pullsRoute(ctx, repo, rest.slice(1));
  fail(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- branches & commits

function branchesRoute(ctx: RestContext, repo: RepoRecord, rest: string[]): void {
  const { forge, req, res } = ctx;
  const method = req.method ?? 'GET';
  if (method !== 'GET') {
    fail(res, 404, 'Not Found');
    return;
  }
  if (rest.length === 0) {
    const branches: Json[] = [];
    for (const [ref, oid] of [...repo.refs.entries()].sort()) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
    }
    sendJson(res, 200, branches);
    return;
  }
  const branch = rest.join('/');
  const tip = forge.branchTip(repo, branch);
  if (tip === null) {
    fail(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
}

function commitsRoute(ctx: RestContext, repo: RepoRecord, rest: string[]): void {
  const { forge, req, res, query } = ctx;
  if ((req.method ?? 'GET') !== 'GET' || rest.length !== 0) {
    fail(res, 404, 'Not Found');
    return;
  }
  const shaParam = query.get('sha') ?? undefined;
  const tip = forge.resolveCommit(repo, shaParam);
  if (tip === null) {
    if (shaParam !== undefined) fail(res, 404, 'Not Found');
    else sendJson(res, 200, []);
    return;
  }
  const { perPage } = pageParams(query);
  const commits: Json[] = [];
  for (const oid of forge.ancestry(tip)) {
    if (commits.length >= perPage) break;
    const object = forge.getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const view = parseCommit(object.data);
    commits.push({
      sha: oid,
      commit: {
        message: view.message.replace(/\n$/, ''),
        author: identityJson(view.author),
        committer: identityJson(view.committer),
        tree: { sha: view.tree },
      },
      parents: view.parents.map((parent) => ({ sha: parent })),
    });
  }
  sendJson(res, 200, commits);
}

function identityJson(line: string): Json {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

// ---------------------------------------------------------------- git data refs

function gitRefsRoute(ctx: RestContext, repo: RepoRecord, rest: string[]): void {
  const { forge, req, res, body } = ctx;
  const method = req.method ?? 'GET';
  const data = bodyObject(body);
  if (method === 'POST' && rest.length === 0) {
    const ref = stringField(data, 'ref');
    const sha = stringField(data, 'sha');
    if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
      fail(res, 422, 'Invalid ref or sha');
      return;
    }
    if (repo.refs.has(ref)) {
      fail(res, 422, 'Reference already exists');
      return;
    }
    const object = forge.getObject(sha);
    if (object === undefined || forge.peelToCommit(sha) === null) {
      fail(res, 422, 'Object does not exist');
      return;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha, type: object.type } });
    return;
  }
  if (method === 'GET' && rest.length === 0) {
    const all: Json[] = [];
    for (const [ref, oid] of [...repo.refs.entries()].sort()) {
      all.push({ ref, object: { sha: oid, type: forge.getObject(oid)?.type ?? 'commit' } });
    }
    sendJson(res, 200, all);
    return;
  }
  if (method === 'GET') {
    const joined = rest.join('/');
    const ref = joined.startsWith('refs/') ? joined : `refs/${joined}`;
    const oid = repo.refs.get(ref);
    if (oid === undefined) {
      fail(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { ref, object: { sha: oid, type: forge.getObject(oid)?.type ?? 'commit' } });
    return;
  }
  fail(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- contents

function contentsRoute(ctx: RestContext, repo: RepoRecord, path: string): void {
  const { forge, req, res, query, body } = ctx;
  const method = req.method ?? 'GET';
  const data = bodyObject(body);

  if (method === 'GET') {
    const found = forge.readContent(repo, path, query.get('ref') ?? undefined);
    if (found === null) {
      fail(res, 404, 'Not Found');
      return;
    }
    if (found.kind === 'file') {
      const object = forge.getObject(found.entry.oid);
      const content = object?.data ?? Buffer.alloc(0);
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        name: path.split('/').pop() ?? path,
        path,
        sha: found.entry.oid,
        size: content.length,
        content: content.toString('base64'),
      });
      return;
    }
    const tree = forge.getObject(found.treeOid);
    const entries: Json[] = [];
    if (tree !== undefined && tree.type === 'tree') {
      for (const entry of parseTree(tree.data)) {
        const entryPath = path === '' ? entry.name : `${path}/${entry.name}`;
        const child = forge.getObject(entry.oid);
        entries.push({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: entryPath,
          sha: entry.oid,
          size: entry.mode === '40000' ? 0 : child?.data.length ?? 0,
        });
      }
    }
    sendJson(res, 200, entries);
    return;
  }

  if (method === 'PUT') {
    const encoded = stringField(data, 'content');
    if (encoded === undefined) {
      fail(res, 422, 'content is required');
      return;
    }
    const content = Buffer.from(encoded.replace(/[\r\n\t ]+/g, ''), 'base64');
    const message = stringField(data, 'message') ?? `Update ${path}`;
    const result = forge.putContent(repo, path, content, message, stringField(data, 'branch'), stringField(data, 'sha'));
    sendJson(res, result.created ? 201 : 200, {
      content: {
        type: 'file',
        name: path.split('/').pop() ?? path,
        path,
        sha: result.blobSha,
        size: content.length,
        encoding: 'base64',
        content: content.toString('base64'),
      },
      commit: { sha: result.commitSha, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const message = stringField(data, 'message') ?? `Delete ${path}`;
    const commitSha = forge.deleteContent(repo, path, message, stringField(data, 'branch'), stringField(data, 'sha'));
    sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
    return;
  }

  fail(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- labels

function labelsRoute(ctx: RestContext, repo: RepoRecord, rest: string[]): void {
  const { req, res, body } = ctx;
  const method = req.method ?? 'GET';
  const data = bodyObject(body);
  if (method === 'GET' && rest.length === 0) {
    sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false })));
    return;
  }
  if (method === 'POST' && rest.length === 0) {
    const name = stringField(data, 'name');
    if (name === undefined || name === '') {
      fail(res, 422, 'Label name is required');
      return;
    }
    if (repo.labels.has(name)) {
      fail(res, 422, 'Label already exists');
      return;
    }
    const label = { name, color: stringField(data, 'color') ?? 'ededed' };
    repo.labels.set(name, label);
    sendJson(res, 201, { name: label.name, color: label.color, default: false });
    return;
  }
  fail(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- issues

function issuesRoute(ctx: RestContext, repo: RepoRecord, rest: string[]): void {
  const { forge, req, res, query, body } = ctx;
  const method = req.method ?? 'GET';
  const data = bodyObject(body);

  if (rest.length === 0) {
    if (method === 'POST') {
      const title = stringField(data, 'title');
      if (title === undefined || title === '') {
        fail(res, 422, 'Title is required');
        return;
      }
      const labels = Array.isArray(data.labels)
        ? data.labels.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const issue = forge.createIssue(repo, title, stringField(data, 'body') ?? '', labels);
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page, perPage } = pageParams(query);
      issues = issues.slice((page - 1) * perPage, page * perPage);
      sendJson(res, 200, issues.map((issue) => issueJson(repo, issue)));
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(rest[0], 10);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (issue === undefined) {
    fail(res, 404, 'Not Found');
    return;
  }
  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const state = stringField(data, 'state');
      if (state !== undefined) {
        if (state !== 'open' && state !== 'closed') {
          fail(res, 422, 'Invalid state');
          return;
        }
        issue.state = state;
      }
      const title = stringField(data, 'title');
      if (title !== undefined) issue.title = title;
      const issueBody = stringField(data, 'body');
      if (issueBody !== undefined) issue.body = issueBody;
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const commentBody = stringField(data, 'body');
      if (commentBody === undefined) {
        fail(res, 422, 'Body is required');
        return;
      }
      const comment = forge.addComment(issue, commentBody);
      sendJson(res, 201, commentJson(comment));
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map(commentJson));
      return;
    }
  }
  fail(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- pulls

function pullsRoute(ctx: RestContext, repo: RepoRecord, rest: string[]): void {
  const { forge, req, res, query, body } = ctx;
  const method = req.method ?? 'GET';
  const data = bodyObject(body);

  if (rest.length === 0) {
    if (method === 'POST') {
      const title = stringField(data, 'title');
      const head = stringField(data, 'head');
      const base = stringField(data, 'base');
      if (title === undefined || head === undefined || base === undefined) {
        fail(res, 422, 'title, head and base are required');
        return;
      }
      const headRef = head.includes(':') ? head.slice(head.indexOf(':') + 1) : head;
      const pull = forge.createPull(repo, title, stringField(data, 'body') ?? '', headRef, base);
      sendJson(res, 201, pullJson(forge, repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      const { page, perPage } = pageParams(query);
      pulls = pulls.slice((page - 1) * perPage, page * perPage);
      sendJson(res, 200, pulls.map((pull) => pullJson(forge, repo, pull)));
      return;
    }
    fail(res, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(rest[0], 10);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) {
    fail(res, 404, 'Not Found');
    return;
  }
  if (rest.length === 1 && method === 'GET') {
    sendJson(res, 200, pullJson(forge, repo, pull));
    return;
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const files = forge.pullFiles(repo, pull).map((change) => {
      const additions = change.status === 'removed' ? 0 : countLines(change.after);
      const deletions = change.status === 'added' ? 0 : countLines(change.before);
      return {
        filename: change.path,
        status: change.status,
        additions,
        deletions,
        changes: additions + deletions,
        sha: '',
      };
    });
    sendJson(res, 200, files);
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull.state !== 'open') {
      fail(res, 405, 'Pull Request is not mergeable');
      return;
    }
    const sha = forge.squashMerge(repo, pull);
    if (sha === null) {
      fail(res, 405, 'Merge conflict: this branch has conflicts that must be resolved');
      return;
    }
    sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  fail(res, 404, 'Not Found');
}
