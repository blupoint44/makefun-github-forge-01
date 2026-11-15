// mcp.ts — the Model Context Protocol endpoint at POST /mcp.
//
// The forge speaks the modern (2026-07-28) MCP era: a stateless, single-JSON
// JSON-RPC endpoint discovered via `server/discover`, with a legacy
// `initialize` fallback. The tool surface mirrors the REST API over the same
// shared store: repositories, issues and pull requests created here are the
// very same objects the REST and GraphQL surfaces see, with the same ids.

import { Forge, ForgeError, VIEWER, type RepoRecord } from './forge.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];
const SERVER_INFO = { name: 'skywe-forge', version: '1.0.0' };

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') {
    throw new ForgeError(400, `Missing or invalid required argument: ${key}`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function findRepo(forge: Forge, args: Record<string, unknown>): RepoRecord {
  const owner = requireString(args, 'owner');
  const name = requireString(args, 'repo');
  const repo = forge.findRepo(owner, name);
  if (repo === null) throw new ForgeError(404, 'Not Found');
  return repo;
}

/** The canonical tool set. The array is a module constant: tools/list answers
 *  are byte-identical across calls, as the protocol expects. */
const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
    run: (forge, args) => {
      const repo = forge.createRepo(requireString(args, 'name'), {
        description: optionalString(args, 'description'),
        isPrivate: args.private === true,
      });
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => repoJson(findRepo(forge, args)),
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated viewer.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: (forge) => forge.viewerRepos().map((repo) => repoJson(repo)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (forge, args) => {
      const repo = findRepo(forge, args);
      const issue = forge.createIssue(repo, requireString(args, 'title'), optionalString(args, 'body'), []);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const repo = findRepo(forge, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number);
      return issues.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        issue_number: { type: 'number', description: 'The issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    run: (forge, args) => {
      const repo = findRepo(forge, args);
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) throw new ForgeError(404, 'Not Found');
      return issueJson(repo, issue);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The pull request title' },
        body: { type: 'string', description: 'The pull request body' },
        head: { type: 'string', description: 'The head branch name' },
        base: { type: 'string', description: 'The base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (forge, args) => {
      const repo = findRepo(forge, args);
      let head = requireString(args, 'head');
      const colon = head.indexOf(':');
      if (colon >= 0) head = head.slice(colon + 1);
      const pull = forge.createPull(repo, requireString(args, 'title'), optionalString(args, 'body'), head, requireString(args, 'base'));
      return pullJson(forge, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (forge, args) => {
      const repo = findRepo(forge, args);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) throw new ForgeError(404, 'Not Found');
      if (pull.state !== 'open') throw new ForgeError(405, 'Pull Request is not open');
      const sha = forge.squashMerge(repo, pull);
      if (sha === null) throw new ForgeError(405, 'Pull Request is not mergeable');
      return { sha, merged: true, message: 'Pull Request successfully merged' };
    },
  },
];

const TOOL_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));

function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

export interface RpcOutcome {
  status: number;
  body: unknown; // null means: no body (notification accepted)
}

function rpcError(id: unknown, code: number, message: string): RpcOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

/** Handle one already-authenticated MCP request body (raw bytes). */
export function handleMcp(forge: Forge, rawBody: Buffer): RpcOutcome {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    // The modern era requires HTTP 400 with a JSON-RPC parse error.
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const method = typeof message.method === 'string' ? message.method : '';
  const hasId = 'id' in message;
  const id = message.id;
  const params = (message.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) are accepted silently.
  if (!hasId) return { status: 202, body: null };

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOL_LIST });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = toolByName(name);
      if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const value = tool.run(forge, args);
        const text = JSON.stringify(value);
        return rpcResult(id, { content: [{ type: 'text', text }], structuredContent: value, isError: false });
      } catch (err) {
        if (err instanceof ForgeError) {
          return rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify({ message: err.message }) }],
            isError: true,
          });
        }
        return rpcResult(id, { content: [{ type: 'text', text: 'Internal error' }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** The login the MCP client resolves through REST — kept for parity checks. */
export const MCP_VIEWER_LOGIN = VIEWER.login;
