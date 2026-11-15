// graphql.ts — the GitHub GraphQL v4 surface at POST /api/graphql.
//
// A small, self-contained GraphQL implementation: a lexer and parser for the
// document subset gh and github-mcp-server send (operations with variables,
// aliases, inline and named fragments, input objects, enum lists, batching),
// a validator that reports unknown fields the way GitHub does (HTTP 200 with
// an `errors` array), and an executor whose resolvers read and write the
// shared Forge store — so a repository or issue is the same object here as
// over REST. Global (Relay) ids are opaque, stable base64 encodings.

import { Forge, ForgeError, VIEWER, type IssueRecord, type PullRecord, type RepoRecord } from './forge.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (index < source.length) {
    const ch = source[index];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\ufeff') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'spread' });
      index += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(index + 3, end) });
        index = end + 3;
        continue;
      }
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') {
          const escaped = source[index + 1];
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escaped === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
            index += 6;
          } else {
            value += simple[escaped] ?? escaped;
            index += 2;
          }
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(index));
      if (match === null) throw new Error('bad number');
      tokens.push({ kind: 'number', value: match[0] });
      index += match[0].length;
      continue;
    }
    if (isNameStart(ch)) {
      let end = index + 1;
      while (end < source.length && isNameChar(source[end])) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos++];
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation or fragment');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        const ahead = this.peek();
        if (ahead !== undefined && ahead.kind === 'name') name = this.expectName();
        if (this.atPunct('(')) this.skipVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          else if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'spread') {
        this.next();
        const ahead = this.peek();
        if (ahead !== undefined && ahead.kind === 'name' && ahead.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.expectName() });
        }
        continue;
      }
      // A field, possibly aliased.
      let name = this.expectName();
      let alias: string | null = null;
      if (this.atPunct(':')) {
        this.next();
        alias = name;
        name = this.expectName();
      }
      const args = new Map<string, ValueNode>();
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.set(argName, this.parseValue());
        }
        this.next();
      }
      this.skipDirectives();
      const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    this.next();
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'number') {
      return { kind: 'literal', value: token.value.includes('.') || /[eE]/.test(token.value) ? Number.parseFloat(token.value) : Number.parseInt(token.value, 10) };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: token.value }; // an enum value reads as its name
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (!this.atPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields.set(key, this.parseValue());
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }
}

// ---------------------------------------------------------------- schema tables

/** Field -> result type, per type: the executor's map and the introspection source. */
const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { id: 'ID', login: 'String', name: 'String', email: 'String' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'String',
    hasIssuesEnabled: 'Boolean',
    isPrivate: 'Boolean',
    description: 'String',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequest: 'PullRequest',
    pullRequests: 'PullRequestConnection',
  },
  Ref: { name: 'String', prefix: 'String' },
  Issue: { id: 'ID', number: 'Int', title: 'String', state: 'String', body: 'String' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequest: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'String',
    merged: 'Boolean',
    mergeable: 'String',
    headRefName: 'String',
    baseRefName: 'String',
    files: 'PullRequestChangedFileConnection',
  },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'CommentEdge', subject: 'Issue', clientMutationId: 'String' },
  CommentEdge: { node: 'IssueComment', cursor: 'String' },
  IssueComment: { id: 'ID', body: 'String' },
  Node: { id: 'ID' },
  __Type: { name: 'String', kind: 'String', fields: '__Field', enumValues: '__EnumValue' },
  __Field: { name: 'String' },
  __EnumValue: { name: 'String' },
  __Schema: { queryType: '__Type', mutationType: '__Type' },
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const OBJECT_TYPES = new Set(Object.keys(FIELD_TYPES));

// ---------------------------------------------------------------- global ids

function encodeId(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decodeId(id: string): string[] {
  try {
    return Buffer.from(id, 'base64').toString('utf8').split(':');
  } catch {
    return [];
  }
}

export function repoGlobalId(repo: RepoRecord): string {
  return encodeId(`Repository:${repo.dbId}`);
}

function issueGlobalId(repo: RepoRecord, issue: IssueRecord): string {
  return encodeId(`Issue:${repo.dbId}:${issue.number}`);
}

function pullGlobalId(repo: RepoRecord, pull: PullRecord): string {
  return encodeId(`PullRequest:${repo.dbId}:${pull.number}`);
}

// ---------------------------------------------------------------- execution

type Node = Record<string, unknown> & { __type: string };

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: DocumentNode['fragments'];
  errors: Array<{ message: string }>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'literal':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolveValue(value, ctx.variables);
  return out;
}

class GqlProblem extends Error {}

function repoNode(repo: RepoRecord): Node {
  return { __type: 'Repository', repo };
}

function issueNode(repo: RepoRecord, issue: IssueRecord): Node {
  return { __type: 'Issue', repo, issue };
}

function pullNode(repo: RepoRecord, pull: PullRecord): Node {
  return { __type: 'PullRequest', repo, pull };
}

function cursorOf(number: number): string {
  return encodeId(`cursor:${number}`);
}

function numberOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  const parts = decodeId(cursor);
  if (parts[0] !== 'cursor') return null;
  const value = Number.parseInt(parts[1] ?? '', 10);
  return Number.isInteger(value) ? value : null;
}

/** Resolve one field on one node; `source` is the node's wrapper object. */
function resolveField(ctx: ExecContext, typeName: string, source: Node, field: FieldNode): unknown {
  const forge = ctx.forge;
  const args = argsOf(field, ctx);
  const name = field.name;
  if (name === '__typename') return typeName;

  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') return { __type: 'User' };
      if (name === 'repository') {
        const repo = forge.findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : repoNode(repo);
      }
      if (name === 'node') return resolveNode(ctx, String(args.id ?? ''));
      if (name === '__type') {
        const typeNameArg = String(args.name ?? '');
        return OBJECT_TYPES.has(typeNameArg) || typeNameArg in ENUM_VALUES ? { __type: '__Type', typeName: typeNameArg } : null;
      }
      if (name === '__schema') return { __type: '__Schema' };
      break;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromGlobalId(ctx, String(input.repositoryId ?? ''));
        if (repo === null) throw new GqlProblem('repository not found');
        const issue = forge.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
        return { __type: 'CreateIssuePayload', repo, issue };
      }
      if (name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueFromGlobalId(ctx, String(input.issueId ?? ''));
        if (found === null) throw new GqlProblem('issue not found');
        found.issue.state = 'closed';
        return { __type: 'CloseIssuePayload', repo: found.repo, issue: found.issue };
      }
      if (name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromGlobalId(ctx, String(input.repositoryId ?? ''));
        if (repo === null) throw new GqlProblem('repository not found');
        const pull = forge.createPull(
          repo,
          String(input.title ?? ''),
          typeof input.body === 'string' ? input.body : '',
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        return { __type: 'CreatePullRequestPayload', repo, pull };
      }
      if (name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = pullFromGlobalId(ctx, String(input.pullRequestId ?? ''));
        if (found === null) throw new GqlProblem('pull request not found');
        if (found.pull.state !== 'open') throw new GqlProblem('pull request is not open');
        if (forge.squashMerge(found.repo, found.pull) === null) throw new GqlProblem('merge conflict');
        return { __type: 'MergePullRequestPayload', repo: found.repo, pull: found.pull };
      }
      if (name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueFromGlobalId(ctx, String(input.subjectId ?? ''));
        if (found === null) throw new GqlProblem('subject not found');
        const comment = forge.addComment(found.issue, String(input.body ?? ''));
        return { __type: 'AddCommentPayload', repo: found.repo, issue: found.issue, comment };
      }
      break;
    }
    case 'User': {
      if (name === 'id') return encodeId(`User:${VIEWER.id}`);
      if (name === 'login') return VIEWER.login;
      if (name === 'name') return VIEWER.name;
      if (name === 'email') return VIEWER.email;
      break;
    }
    case 'Repository': {
      const repo = source.repo as RepoRecord;
      switch (name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.dbId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.ownerLogin}/${repo.name}`;
        case 'owner':
          return { __type: 'User' };
        case 'defaultBranchRef': {
          const tip = forge.branchTip(repo, repo.defaultBranch);
          return tip === null ? null : { __type: 'Ref', refName: repo.defaultBranch };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'isPrivate':
          return repo.isPrivate;
        case 'description':
          return repo.description;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueNode(repo, issue);
        }
        case 'issues':
          return issuesConnection(ctx, repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullNode(repo, pull);
        }
        case 'pullRequests': {
          const all = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
          const first = typeof args.first === 'number' ? args.first : all.length;
          const page = all.slice(0, first);
          return {
            __type: 'PullRequestConnection',
            repo,
            page,
            totalCount: all.length,
            hasNextPage: page.length < all.length,
            endCursor: page.length > 0 ? cursorOf(page[page.length - 1].number) : null,
          };
        }
      }
      break;
    }
    case 'Ref': {
      if (name === 'name') return source.refName as string;
      if (name === 'prefix') return 'refs/heads/';
      break;
    }
    case 'Issue': {
      const repo = source.repo as RepoRecord;
      const issue = source.issue as IssueRecord;
      switch (name) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state.toUpperCase();
        case 'body':
          return issue.body;
      }
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      if (name === 'nodes') {
        const page = source.page as Array<IssueRecord | PullRecord>;
        const repo = source.repo as RepoRecord;
        return page.map((entry) =>
          typeName === 'IssueConnection' ? issueNode(repo, entry as IssueRecord) : pullNode(repo, entry as PullRecord),
        );
      }
      if (name === 'totalCount') return source.totalCount as number;
      if (name === 'pageInfo') {
        return {
          __type: 'PageInfo',
          hasNextPage: source.hasNextPage as boolean,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: source.endCursor as string | null,
        };
      }
      break;
    }
    case 'PullRequest': {
      const repo = source.repo as RepoRecord;
      const pull = source.pull as PullRecord;
      switch (name) {
        case 'id':
          return pullGlobalId(repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return forge.mergeableState(repo, pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'files': {
          const files = forge.pullFiles(repo, pull).map((change) => ({
            path: change.path,
            additions: change.after === null ? 0 : countLines(change.after),
            deletions: change.before === null ? 0 : countLines(change.before),
          }));
          const first = typeof args.first === 'number' ? args.first : files.length;
          return { __type: 'PullRequestChangedFileConnection', files: files.slice(0, first), totalCount: files.length };
        }
      }
      break;
    }
    case 'PullRequestChangedFileConnection': {
      if (name === 'nodes') {
        return (source.files as Array<{ path: string }>).map((file) => ({ __type: 'PullRequestChangedFile', ...file }));
      }
      if (name === 'totalCount') return source.totalCount as number;
      if (name === 'pageInfo') {
        return { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
      }
      break;
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return source.path as string;
      if (name === 'additions') return source.additions as number;
      if (name === 'deletions') return source.deletions as number;
      break;
    }
    case 'PageInfo': {
      if (name in source) return source[name] as unknown;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return issueNode(source.repo as RepoRecord, source.issue as IssueRecord);
      if (name === 'clientMutationId') return null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return pullNode(source.repo as RepoRecord, source.pull as PullRecord);
      if (name === 'clientMutationId') return null;
      break;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') {
        return { __type: 'CommentEdge', repo: source.repo, issue: source.issue, comment: source.comment };
      }
      if (name === 'subject') return issueNode(source.repo as RepoRecord, source.issue as IssueRecord);
      if (name === 'clientMutationId') return null;
      break;
    }
    case 'CommentEdge': {
      if (name === 'node') {
        return { __type: 'IssueComment', repo: source.repo, issue: source.issue, comment: source.comment };
      }
      if (name === 'cursor') return cursorOf(0);
      break;
    }
    case 'IssueComment': {
      const repo = source.repo as RepoRecord;
      const issue = source.issue as IssueRecord;
      const comment = source.comment as { id: number; body: string };
      if (name === 'id') return encodeId(`IssueComment:${repo.dbId}:${issue.number}:${comment.id}`);
      if (name === 'body') return comment.body;
      break;
    }
    case '__Type': {
      const typeNameArg = source.typeName as string;
      if (name === 'name') return typeNameArg;
      if (name === 'kind') return typeNameArg in ENUM_VALUES ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        const fields = FIELD_TYPES[typeNameArg];
        if (fields === undefined) return null;
        return Object.keys(fields).map((fieldName) => ({ __type: '__Field', fieldName }));
      }
      if (name === 'enumValues') {
        const values = ENUM_VALUES[typeNameArg];
        if (values === undefined) return null;
        return values.map((value) => ({ __type: '__EnumValue', valueName: value }));
      }
      break;
    }
    case '__Field': {
      if (name === 'name') return source.fieldName as string;
      break;
    }
    case '__EnumValue': {
      if (name === 'name') return source.valueName as string;
      break;
    }
    case '__Schema': {
      if (name === 'queryType') return { __type: '__Type', typeName: 'Query' };
      if (name === 'mutationType') return { __type: '__Type', typeName: 'Mutation' };
      break;
    }
  }
  return null;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const lines = data.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function issuesConnection(ctx: ExecContext, repo: RepoRecord, args: Record<string, unknown>): Node {
  void ctx;
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const descending = orderBy.direction === 'DESC';
  issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  let startIndex = 0;
  const afterNumber = numberOfCursor(args.after);
  if (afterNumber !== null) {
    const at = issues.findIndex((issue) => issue.number === afterNumber);
    if (at >= 0) startIndex = at + 1;
  }
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : issues.length;
  const page = issues.slice(startIndex, startIndex + first);
  return {
    __type: 'IssueConnection',
    repo,
    page,
    totalCount: issues.length,
    hasNextPage: startIndex + page.length < issues.length,
    endCursor: page.length > 0 ? cursorOf(page[page.length - 1].number) : null,
  };
}

function repoFromGlobalId(ctx: ExecContext, id: string): RepoRecord | null {
  const parts = decodeId(id);
  if (parts[0] !== 'Repository') return null;
  return ctx.forge.repoByDbId(Number.parseInt(parts[1] ?? '', 10));
}

function issueFromGlobalId(ctx: ExecContext, id: string): { repo: RepoRecord; issue: IssueRecord } | null {
  const parts = decodeId(id);
  if (parts[0] !== 'Issue') return null;
  const repo = ctx.forge.repoByDbId(Number.parseInt(parts[1] ?? '', 10));
  if (repo === null) return null;
  const issue = repo.issues.get(Number.parseInt(parts[2] ?? '', 10));
  return issue === undefined ? null : { repo, issue };
}

function pullFromGlobalId(ctx: ExecContext, id: string): { repo: RepoRecord; pull: PullRecord } | null {
  const parts = decodeId(id);
  if (parts[0] !== 'PullRequest') return null;
  const repo = ctx.forge.repoByDbId(Number.parseInt(parts[1] ?? '', 10));
  if (repo === null) return null;
  const pull = repo.pulls.get(Number.parseInt(parts[2] ?? '', 10));
  return pull === undefined ? null : { repo, pull };
}

function resolveNode(ctx: ExecContext, id: string): Node | null {
  const parts = decodeId(id);
  if (parts[0] === 'Repository') {
    const repo = ctx.forge.repoByDbId(Number.parseInt(parts[1] ?? '', 10));
    return repo === null ? null : repoNode(repo);
  }
  if (parts[0] === 'Issue') {
    const found = issueFromGlobalId(ctx, id);
    return found === null ? null : issueNode(found.repo, found.issue);
  }
  if (parts[0] === 'PullRequest') {
    const found = pullFromGlobalId(ctx, id);
    return found === null ? null : pullNode(found.repo, found.pull);
  }
  if (parts[0] === 'User') return { __type: 'User' };
  return null;
}

// ---------------------------------------------------------------- validation

function validateSelections(
  selections: readonly SelectionNode[],
  parentType: string,
  fragments: DocumentNode['fragments'],
  errors: Array<{ message: string }>,
  depth = 0,
): void {
  if (depth > 24) return;
  const fields = FIELD_TYPES[parentType];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      if (fields === undefined || !(selection.name in fields)) {
        errors.push({ message: `Field '${selection.name}' doesn't exist on type '${parentType}'` });
        continue;
      }
      if (selection.selectionSet !== null) {
        validateSelections(selection.selectionSet, fields[selection.name], fragments, errors, depth + 1);
      }
      continue;
    }
    if (selection.kind === 'inline') {
      validateSelections(selection.selectionSet, selection.typeCondition ?? parentType, fragments, errors, depth + 1);
      continue;
    }
    const fragment = fragments.get(selection.name);
    if (fragment !== undefined) validateSelections(fragment.selectionSet, fragment.typeCondition, fragments, errors, depth + 1);
  }
}

// ---------------------------------------------------------------- completion

function completeValue(
  ctx: ExecContext,
  typeName: string,
  value: unknown,
  selectionSet: SelectionNode[] | null,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, typeName, entry, selectionSet));
  if (typeof value === 'object' && selectionSet !== null && typeName === 'Node') {
    // The Node interface completes against the value's concrete type.
    const node = value as Node;
    return executeSelectionSet(ctx, node.__type, node, selectionSet);
  }
  if (typeof value === 'object' && selectionSet !== null && OBJECT_TYPES.has(typeName)) {
    return executeSelectionSet(ctx, typeName, value as Node, selectionSet);
  }
  return value;
}

function executeSelectionSet(
  ctx: ExecContext,
  typeName: string,
  source: Node,
  selections: readonly SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const run = (list: readonly SelectionNode[], currentType: string): void => {
    for (const selection of list) {
      if (selection.kind === 'field') {
        const key = selection.alias ?? selection.name;
        const childType = FIELD_TYPES[currentType]?.[selection.name] ?? 'String';
        let value: unknown;
        try {
          value = resolveField(ctx, currentType, source, selection);
        } catch (err) {
          if (err instanceof GqlProblem || err instanceof ForgeError) {
            ctx.errors.push({ message: err.message });
            value = null;
          } else {
            throw err;
          }
        }
        out[key] = completeValue(ctx, childType, value, selection.selectionSet);
        continue;
      }
      if (selection.kind === 'inline') {
        if (selection.typeCondition === null || selection.typeCondition === source.__type) {
          run(selection.selectionSet, selection.typeCondition ?? currentType);
        }
        continue;
      }
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === source.__type) {
        run(fragment.selectionSet, fragment.typeCondition);
      }
    }
  };
  run(selections, typeName);
  return out;
}

// ---------------------------------------------------------------- entry point

export interface GraphQLRequestBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

/** Execute one GraphQL operation body; answers the {data}/{errors} envelope. */
export function executeGraphQL(forge: Forge, body: GraphQLRequestBody): Record<string, unknown> {
  if (typeof body.query !== 'string' || body.query.trim() === '') {
    return { errors: [{ message: 'A query document is required' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(lex(body.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation =
    document.operations.find((candidate) => operationName !== null && candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation in the document' }] };

  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: Array<{ message: string }> = [];
  validateSelections(operation.selectionSet, rootType, document.fragments, validationErrors);
  if (validationErrors.length > 0) return { errors: validationErrors };

  const ctx: ExecContext = {
    forge,
    variables: typeof body.variables === 'object' && body.variables !== null ? (body.variables as Record<string, unknown>) : {},
    fragments: document.fragments,
    errors: [],
  };
  const data = executeSelectionSet(ctx, rootType, { __type: rootType }, operation.selectionSet);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}
