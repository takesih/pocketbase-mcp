

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import PocketBase from 'pocketbase';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function generateFieldId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 15; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function assignFieldIds(fields: any[]): any[] {
  if (!fields) return [];
  return fields.map((field: any) => ({
    ...field,
    id: field.id || generateFieldId(),
  }));
}

class PocketBaseServer {
  private server: Server;
  private pb!: PocketBase;
  private sseConfig: Record<string, string> = {};

  getServer(): Server {
    return this.server;
  }

  constructor() {
    this.server = new Server(
      {
        name: 'pocketbase-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // If POCKETBASE_URL is in env, initialize immediately (backward compat for stdio mode)
    const url = process.env.POCKETBASE_URL;
    if (url) {
      this.pb = new PocketBase(url);
    }

    this.setupToolHandlers();

    this.server.onerror = (error: unknown) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  /** Look up a value from SSE headers first, then fall back to env vars. */
  private getHeader(name: string): string | undefined {
    const lowerName = name.toLowerCase();
    if (this.sseConfig[lowerName]) return this.sseConfig[lowerName];
    const envMap: Record<string, string> = {
      'x-pocketbase-url': 'POCKETBASE_URL',
      'x-pocketbase-admin-email': 'POCKETBASE_ADMIN_EMAIL',
      'x-pocketbase-admin-password': 'POCKETBASE_ADMIN_PASSWORD',
      'x-pocketbase-api-key': 'POCKETBASE_API_KEY',
    };
    const envName = envMap[lowerName];
    return envName ? process.env[envName] : undefined;
  }

  /** Configure PocketBase connection from SSE request headers. */
  configureFromHeaders(headers: Record<string, string | string[] | undefined>) {
    for (const [key, value] of Object.entries(headers)) {
      if (value && typeof value === 'string') {
        this.sseConfig[key.toLowerCase()] = value;
      }
    }
    if (!this.pb) {
      const url = this.getHeader('X-Pocketbase-Url');
      if (!url) {
        throw new Error('PocketBase URL is required — set X-Pocketbase-Url header or POCKETBASE_URL env');
      }
      this.pb = new PocketBase(url);
    }
  }

  // Session management for SSE mode
  private sessions: Map<string, SSEServerTransport> = new Map();

  createSSETransport(req: any, res: any): SSEServerTransport {
    const transport = new SSEServerTransport('/sse', res);
    this.sessions.set(transport.sessionId, transport);
    return transport;
  }

  getTransportForSession(sessionId: string): SSEServerTransport | undefined {
    return this.sessions.get(sessionId);
  }

  async connectTransport(transport: SSEServerTransport) {
    transport.onclose = () => {
      this.sessions.delete(transport.sessionId);
    };
    await this.server.connect(transport);
  }

  private async adminAuth() {
      if (!this.pb) {
        throw new Error('PocketBase not initialized. Ensure SSE connection has X-Pocketbase-Url header or set POCKETBASE_URL env.');
      }
      // Prefer API Key authentication if provided
      const apiKey = this.getHeader('X-Pocketbase-Api-Key') || process.env.POCKETBASE_API_KEY;
      if (apiKey) {
        // PocketBase SDK stores the token directly in authStore
        this.pb.authStore.save(apiKey, null);
        return;
      }
      // Fallback to Basic Auth from Authorization header (Base64 encoded email:password)
      const authHeader = process.env.POCKETBASE_AUTH_HEADER;
      if (authHeader && authHeader.startsWith('Basic ')) {
        try {
          const base64Credentials = authHeader.slice(6);
          const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
          const [email, password] = credentials.split(':');
          if (email && password) {
            await this.pb.collection('_superusers').authWithPassword(email, password);
            return;
          }
        } catch (e) {
          console.error('Failed to parse Basic Auth header:', e);
        }
      }
      // Fallback to email/password from SSE headers or env
      const email = this.getHeader('X-Pocketbase-Admin-Email') ?? process.env.POCKETBASE_ADMIN_EMAIL ?? '';
      const password = this.getHeader('X-Pocketbase-Admin-Password') ?? process.env.POCKETBASE_ADMIN_PASSWORD ?? '';
      if (email && password) {
        await this.pb.collection('_superusers').authWithPassword(email, password);
      }
    }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'create_collection',
          description: 'Create a new collection in PocketBase note never use created and updated because these are already created',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Unique collection name (used as a table name for the records table)' },
              type: { type: 'string', description: 'Type of the collection', enum: ['base', 'view', 'auth'], default: 'base' },
              fields: {
                type: 'array',
                description: 'List with the collection fields',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Field name' },
                    type: { type: 'string', description: 'Field type', enum: ['bool', 'date', 'number', 'text', 'email', 'url', 'editor', 'autodate', 'select', 'file', 'relation', 'json', 'geoPoint'] },
                    required: { type: 'boolean', description: 'Is field required?' },
                    values: { type: 'array', items: { type: 'string' }, description: 'Allowed values for select type fields' },
                    collectionId: { type: 'string', description: 'Collection ID for relation type fields' }
                  },
                },
              },
              createRule: { type: 'string', description: 'API rule for creating records' },
              updateRule: { type: 'string', description: 'API rule for updating records' },
              deleteRule: { type: 'string', description: 'API rule for deleting records' },
              listRule: { type: 'string', description: 'API rule for listing and viewing records' },
              viewRule: { type: 'string', description: 'API rule for viewing a single record' },
              viewQuery: { type: 'string', description: 'SQL query for view collections' },
              passwordAuth: {
                type: 'object',
                description: 'Password authentication options',
                properties: {
                  enabled: { type: 'boolean', description: 'Is password authentication enabled?' },
                  identityFields: { type: 'array', items: { type: 'string' }, description: 'Fields used for identity in password authentication' },
                },
              },
            },
            required: ['name', 'fields'],
          },
        },
        {
          name: 'update_collection',
          description: 'Update an existing collection in PocketBase (admin only)',
          inputSchema: {
            type: 'object',
            properties: {
              collectionIdOrName: { type: 'string', description: 'ID or name of the collection to update' },
              name: { type: 'string', description: 'New unique collection name' },
              type: { type: 'string', description: 'Type of the collection', enum: ['base', 'view', 'auth'] },
              fields: {
                type: 'array',
                description: 'List with the new collection fields. If not empty, the old schema will be replaced.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Field name' },
                    type: { type: 'string', description: 'Field type', enum: ['bool', 'date', 'number', 'text', 'email', 'url', 'editor', 'autodate', 'select', 'file', 'relation', 'json', 'geoPoint'] },
                    required: { type: 'boolean', description: 'Is field required?' },
                    values: { type: 'array', items: { type: 'string' }, description: 'Allowed values for select type fields' },
                    collectionId: { type: 'string', description: 'Collection ID for relation type fields' }
                  },
                },
              },
              createRule: { type: 'string', description: 'API rule for creating records' },
              updateRule: { type: 'string', description: 'API rule for updating records' },
              deleteRule: { type: 'string', description: 'API rule for deleting records' },
              listRule: { type: 'string', description: 'API rule for listing and viewing records' },
              viewRule: { type: 'string', description: 'API rule for viewing a single record' },
              viewQuery: { type: 'string', description: 'SQL query for view collections' },
              passwordAuth: {
                type: 'object',
                description: 'Password authentication options',
                properties: {
                  enabled: { type: 'boolean', description: 'Is password authentication enabled?' },
                  identityFields: { type: 'array', items: { type: 'string' }, description: 'Fields used for identity in password authentication' },
                },
              },
            },
            required: ['collectionIdOrName'],
          },
        },
        {
          name: 'create_record',
          description: 'Create a new record in a collection',
          inputSchema: {
            type: 'object',
            properties: {
              collection: { type: 'string', description: 'Collection name' },
              data: {
                type: 'object',
                description: 'Record data (any fields)',
                additionalProperties: true,
              },
            },
            required: ['collection', 'data'],
          },
        },
        {
          name: 'list_records',
          description: 'List records from a collection with optional filters',
          inputSchema: {
            type: 'object',
            properties: {
              collection: { type: 'string', description: 'Collection name' },
              filter: { type: 'string', description: 'Filter query' },
              sort: { type: 'string', description: 'Sort field and direction' },
              page: { type: 'number', description: 'Page number' },
              perPage: { type: 'number', description: 'Items per page' },
            },
            required: ['collection'],
          },
        },
        {
          name: 'update_record',
          description: 'Update an existing record',
          inputSchema: {
            type: 'object',
            properties: {
              collection: { type: 'string', description: 'Collection name' },
              id: { type: 'string', description: 'Record ID' },
              data: {
                type: 'object',
                description: 'Updated record data (any fields)',
                additionalProperties: true,
              },
            },
            required: ['collection', 'id', 'data'],
          },
        },
        {
          name: 'delete_record',
          description: 'Delete a record',
          inputSchema: {
            type: 'object',
            properties: {
              collection: { type: 'string', description: 'Collection name' },
              id: { type: 'string', description: 'Record ID' },
            },
            required: ['collection', 'id'],
          },
        },
        {
          name: 'authenticate_user',
          description: 'Authenticate a user with email and password',
          inputSchema: {
            type: 'object',
            properties: {
              email: { type: 'string', description: 'User email' },
              password: { type: 'string', description: 'User password' },
              collection: { type: 'string', description: 'Collection name (default: users)', default: 'users' },
              isAdmin: {
                type: 'boolean',
                description: 'Whether to authenticate as an admin (uses _superusers collection)',
                default: false,
              },
            },
            required: ['email', 'password'],
          },
        },
        {
          name: 'create_user',
          description: 'Create a new user account',
          inputSchema: {
            type: 'object',
            properties: {
              email: { type: 'string', description: 'User email' },
              password: { type: 'string', description: 'User password' },
              passwordConfirm: { type: 'string', description: 'Password confirmation' },
              name: { type: 'string', description: 'User name' },
              collection: { type: 'string', description: 'Collection name (default: users)', default: 'users' },
            },
            required: ['email', 'password', 'passwordConfirm'],
          },
        },
        {
          name: 'get_collection',
          description: 'Get details for a collection',
          inputSchema: {
            type: 'object',
            properties: {
              collectionIdOrName: { type: 'string', description: 'ID or name of the collection to view' },
              fields: { type: 'string', description: 'Comma separated string of the fields to return in the JSON response' },
            },
            required: ['collectionIdOrName'],
          },
        },
        {
          name: 'backup_database',
          description: 'Create a backup of the PocketBase database',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'backup name' },
            },
          },
        },
        {
          name: 'import_data',
          description: 'Import data into a collection',
          inputSchema: {
            type: 'object',
            properties: {
              collection: { type: 'string', description: 'Collection name' },
              data: {
                type: 'array',
                description: 'Array of records to import',
                items: { type: 'object' },
              },
              mode: {
                type: 'string',
                enum: ['create', 'update', 'upsert'],
                description: 'Import mode (default: create)',
              },
            },
            required: ['collection', 'data'],
          },
        },
        {
          name: 'list_collections',
          description: 'List all collections in PocketBase',
          inputSchema: {
            type: 'object',
            properties: {
              filter: { type: 'string', description: 'Filter query for collections' },
              sort: { type: 'string', description: 'Sort order for collections' },
            },
          },
        },
        {
          name: 'delete_collection',
          description: 'Delete a collection from PocketBase (admin only)',
          inputSchema: {
            type: 'object',
            properties: {
              collectionIdOrName: { type: 'string', description: 'ID or name of the collection to delete' },
            },
            required: ['collectionIdOrName'],
          },
        },
        {
          name: 'auth_refresh',
          description: 'Refresh authentication token',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'list_auth_methods',
          description: 'List all available authentication methods',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'authenticate_with_oauth2',
          description: 'Authenticate a user with OAuth2',
          inputSchema: {
            type: 'object',
            properties: {
              provider: { type: 'string', description: 'OAuth2 provider name (e.g., google, facebook, github)' },
              code: { type: 'string', description: 'The authorization code returned from the OAuth2 provider' },
              codeVerifier: { type: 'string', description: 'PKCE code verifier' },
              redirectUrl: { type: 'string', description: 'The redirect URL used in the OAuth2 flow' },
            },
            required: ['provider', 'code'],
          },
        },
        {
          name: 'authenticate_with_otp',
          description: 'Authenticate a user with one-time password',
          inputSchema: {
            type: 'object',
            properties: {
              email: { type: 'string', description: 'User email' },
            },
            required: ['email'],
          },
        },
        {
          name: 'request_verification',
          description: 'Request email verification',
          inputSchema: {
            type: 'object',
            properties: {
              email: { type: 'string', description: 'User email' },
            },
            required: ['email'],
          },
        },
        {
          name: 'confirm_verification',
          description: 'Confirm email verification with token',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string', description: 'Verification token' },
            },
            required: ['token'],
          },
        },
        {
          name: 'request_password_reset',
          description: 'Request password reset',
          inputSchema: {
            type: 'object',
            properties: {
              email: { type: 'string', description: 'User email' },
            },
            required: ['email'],
          },
        },
        {
          name: 'confirm_password_reset',
          description: 'Confirm password reset with token',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string', description: 'Reset token' },
              newPassword: { type: 'string', description: 'New password' },
              confirmNewPassword: { type: 'string', description: 'Confirm new password' },
            },
            required: ['token', 'newPassword'],
          },
        },
        {
          name: 'request_email_change',
          description: 'Request email change',
          inputSchema: {
            type: 'object',
            properties: {
              newEmail: { type: 'string', description: 'New email address' },
              password: { type: 'string', description: 'Current password for confirmation' },
            },
            required: ['newEmail'],
          },
        },
        {
          name: 'confirm_email_change',
          description: 'Confirm email change with token',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string', description: 'Email change token' },
              password: { type: 'string', description: 'Current password for confirmation' },
            },
            required: ['token'],
          },
        },
        {
          name: 'impersonate_user',
          description: 'Impersonate another user (admin only)',
          inputSchema: {
            type: 'object',
            properties: {
              userId: { type: 'string', description: 'ID of the user to impersonate' },
              durationSeconds: { type: 'number', description: 'Duration in seconds for impersonation', default: 3600 },
            },
            required: ['userId'],
          },
        },

      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case 'create_collection':
            return await this.createCollection(request.params.arguments);
          case 'update_collection':
            return await this.updateCollection(request.params.arguments);
          case 'create_record':
            return await this.createRecord(request.params.arguments);
          case 'list_records':
            return await this.listRecords(request.params.arguments);
          case 'update_record':
            return await this.updateRecord(request.params.arguments);
          case 'delete_record':
            return await this.deleteRecord(request.params.arguments);
          case 'authenticate_user':
            return await this.authenticateUser(request.params.arguments);
          case 'create_user':
            return await this.createUser(request.params.arguments);
          case 'get_collection':
            return await this.getCollection(request.params.arguments);
          case 'backup_database':
            return await this.backupDatabase(request.params.arguments);
          case 'import_data':
            return await this.importData(request.params.arguments);
          case 'list_collections':
            return await this.listCollections(request.params.arguments);
          case 'delete_collection':
            return await this.deleteCollection(request.params.arguments);
          case 'auth_refresh':
            return await this.authRefresh(request.params.arguments);
          case 'list_auth_methods':
            return await this.listAuthMethods(request.params.arguments);
          case 'authenticate_with_oauth2':
            return await this.authenticateWithOAuth2(request.params.arguments);
          case 'authenticate_with_otp':
            return await this.authenticateWithOTP(request.params.arguments);
          case 'request_verification':
            return await this.requestVerification(request.params.arguments);
          case 'confirm_verification':
            return await this.confirmVerification(request.params.arguments);
          case 'request_password_reset':
            return await this.requestPasswordReset(request.params.arguments);
          case 'confirm_password_reset':
            return await this.confirmPasswordReset(request.params.arguments);
          case 'request_email_change':
            return await this.requestEmailChange(request.params.arguments);
          case 'confirm_email_change':
            return await this.confirmEmailChange(request.params.arguments);
          case 'impersonate_user':
            return await this.impersonateUser(request.params.arguments);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error: unknown) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `PocketBase error: ${pocketbaseErrorMessage(error)}`
        );
      }
    });
  }

  private async createCollection(args: any) {
    try {
      await this.adminAuth();

      const defaultFields = [
        { hidden: false, id: "autodate_created", name: "created", onCreate: true, onUpdate: false, presentable: false, system: false, type: "autodate" },
        { hidden: false, id: "autodate_updated", name: "updated", onCreate: true, onUpdate: true, presentable: false, system: false, type: "autodate" }
      ];

      const collectionData = { ...args, fields: [...(assignFieldIds(args.fields || [])), ...defaultFields] };
      const result = await this.pb.collections.create(collectionData as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to create collection: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async updateCollection(args: any) {
    try {
      await this.adminAuth();
      const { collectionIdOrName, ...updateData } = args;
      const result = await this.pb.collections.update(collectionIdOrName, updateData as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to update collection: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async createRecord(args: any) {
    try {
      // Auth for listRule-closed collections
      await this.adminAuth();
      const result = await this.pb.collection(args.collection).create(args.data);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to create record: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async listRecords(args: any) {
    try {
      await this.adminAuth();
      const options: any = {};
      if (args.filter) options.filter = args.filter;
      if (args.sort) options.sort = args.sort;
      if (args.page) options.page = args.page;
      if (args.perPage) options.perPage = args.perPage;

      const result = await this.pb.collection(args.collection).getList(
        options.page || 1, options.perPage || 50,
        { filter: options.filter, sort: options.sort }
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to list records: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async updateRecord(args: any) {
    try {
      // Auth for listRule-closed collections
      await this.adminAuth();
      const result = await this.pb.collection(args.collection).update(args.id, args.data);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to update record: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async deleteRecord(args: any) {
    try {
      // Auth for listRule-closed collections
      await this.adminAuth();
      await this.pb.collection(args.collection).delete(args.id);
      return { content: [{ type: 'text', text: `Successfully deleted record ${args.id} from collection ${args.collection}` }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to delete record: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async authenticateUser(args: any) {
    try {
      const collection = args.isAdmin ? '_superusers' : (args.collection || 'users');
      const email = args.isAdmin && !args.email ? process.env.POCKETBASE_ADMIN_EMAIL : args.email;
      const password = args.isAdmin && !args.password ? process.env.POCKETBASE_ADMIN_PASSWORD : args.password;

      if (!email || !password) {
        throw new Error('Email and password are required for authentication');
      }

      const authData = await this.pb.collection(collection).authWithPassword(email, password);
      return { content: [{ type: 'text', text: JSON.stringify(authData, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Authentication failed: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async createUser(args: any) {
    try {
      await this.adminAuth();
      const collection = args.collection || 'users';
      const result = await this.pb.collection(collection).create({
        email: args.email, password: args.password,
        passwordConfirm: args.passwordConfirm, name: args.name,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to create user: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async getCollection(args: any) {
    try {
      await this.adminAuth();
      const collection = await this.pb.collections.getOne(args.collectionIdOrName, { fields: args.fields });
      return { content: [{ type: 'text', text: JSON.stringify(collection, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to get collection: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async backupDatabase(args: any) {
    try {
      await this.adminAuth();
      const backupResult = await this.pb.backups.create(args.name ?? '', {});
      return { content: [{ type: 'text', text: JSON.stringify(backupResult, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to backup database: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async importData(args: any) {
    try {
      await this.adminAuth();
      const collection = args.collection;
      const mode = args.mode || 'create';
      for (const record of args.data) {
        if (mode === 'update') {
          await this.pb.collection(collection).update(record.id, record);
        } else if (mode === 'upsert') {
          try {
            await this.pb.collection(collection).getFirstListItem(`id = "${record.id}"`);
            await this.pb.collection(collection).update(record.id, record);
          } catch {
            await this.pb.collection(collection).create(record);
          }
        } else {
          await this.pb.collection(collection).create(record);
        }
      }
      return { content: [{ type: 'text', text: `Successfully imported ${args.data.length} records in ${mode} mode` }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to import data: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async listCollections(args: any) {
    try {
      await this.adminAuth();
      let collections;
      if (args.filter) {
        collections = await this.pb.collections.getFirstListItem(args.filter);
      } else if (args.sort) {
        collections = await this.pb.collections.getFullList({ sort: args.sort });
      } else {
        collections = await this.pb.collections.getList(1, 100);
      }
      return { content: [{ type: 'text', text: JSON.stringify(collections, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to list collections: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async deleteCollection(args: any) {
    try {
      await this.adminAuth();
      await this.pb.collections.delete(args.collectionIdOrName);
      return { content: [{ type: 'text', text: `Successfully deleted collection ${args.collectionIdOrName}` }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to delete collection: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async authRefresh(args: any) {
    try {
      await this.adminAuth();
      const collection = args?.collection || '_superusers';
      const result = await this.pb.collection(collection).authRefresh();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to refresh auth: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async listAuthMethods(args: any) {
    try {
      const methods = await this.pb.collection('users').listAuthMethods();
      return { content: [{ type: 'text', text: JSON.stringify(methods, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to list auth methods: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async authenticateWithOAuth2(args: any) {
    try {
      const result = await this.pb.collection('users').authWithOAuth2Code(
        args.provider,
        args.code,
        args.codeVerifier,
        args.redirectUrl,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `OAuth2 authentication failed: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async authenticateWithOTP(args: any) {
    try {
      const result = await this.pb.collection('users').requestOTP(args.email);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `OTP authentication failed: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async requestVerification(args: any) {
    try {
      await this.adminAuth();
      const result = await this.pb.collection('users').requestVerification(args.email);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to request verification: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async confirmVerification(args: any) {
    try {
      const result = await this.pb.collection('users').confirmVerification(args.token);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to confirm verification: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async requestPasswordReset(args: any) {
    try {
      await this.adminAuth();
      const result = await this.pb.collection('users').requestPasswordReset(args.email);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to request password reset: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async confirmPasswordReset(args: any) {
    try {
      const result = await this.pb.collection('users').confirmPasswordReset(
        args.token,
        args.newPassword,
        args.confirmNewPassword ?? args.newPassword,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to confirm password reset: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async requestEmailChange(args: any) {
    try {
      const result = await this.pb.collection('users').requestEmailChange(args.newEmail);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to request email change: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async confirmEmailChange(args: any) {
    try {
      const result = await this.pb.collection('users').confirmEmailChange(
        args.token,
        args.password || '',
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to confirm email change: ${pocketbaseErrorMessage(error)}`);
    }
  }

  private async impersonateUser(args: any) {
    try {
      await this.adminAuth();
      const result = await this.pb.collection('users').impersonate(
        args.userId,
        args.durationSeconds || 3600,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to impersonate user: ${pocketbaseErrorMessage(error)}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('PocketBase MCP server running on stdio');
  }
}

export function flattenErrors(errors: unknown): string[] {
  if (Array.isArray(errors)) {
    return errors.flatMap(flattenErrors);
  } else if (typeof errors === "object" && errors !== null) {
    const errorObject = errors as Record<string, any>;

    if (errorObject.message) {
      return [errorObject.message, ...flattenErrors(errorObject.data || {})];
    }

    if (errorObject.data) {
      const messages: string[] = [];
      for (const key in errorObject.data) {
        const value = errorObject.data[key];
        if (typeof value === "object" && value !== null) {
          messages.push(...flattenErrors(value));
        }
      }
      if (messages.length > 0) {
        return messages;
      }
    }

    return Object.values(errorObject).flatMap(flattenErrors);
  } else if (typeof errors === "string") {
    return [errors];
  } else {
    return [];
  }
}

export function pocketbaseErrorMessage(errors: unknown): string {
  const messages = flattenErrors(errors);
  return messages.length > 0 ? messages.join("\n") : "No errors found";
}

// Main execution
async function main() {
  const url = process.env.POCKETBASE_URL;
  const apiKey = process.env.POCKETBASE_API_KEY;
  const port = parseInt(process.env.PORT || '3000', 10);
  
  // URL can come from SSE request headers (X-Pocketbase-Url) or env var
  // In stdio mode the env var is required
  if (!url && process.env.POCKETBASE_HTTP_MODE !== 'true') {
    throw new Error('POCKETBASE_URL environment variable is required for stdio mode');
  }
  
  // HTTP/SSE mode - when POCKETBASE_PORT is set
  if (process.env.POCKETBASE_HTTP_MODE === 'true') {
    const http = await import('http');
    const pbServer = new PocketBaseServer();

    const streamableTransports: Record<string, StreamableHTTPServerTransport> = {};

    const server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Pocketbase-Url, X-Pocketbase-Admin-Email, X-Pocketbase-Admin-Password, X-Pocketbase-Api-Key, Mcp-Session-Id');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      if (apiKey) {
        const authHeader = req.headers.authorization || '';
        const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (bearerKey !== apiKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      if (req.url?.startsWith('/mcp')) {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && streamableTransports[sessionId]) {
          transport = streamableTransports[sessionId];
        } else if (req.method === 'POST') {
          const rawBody = await readBody(req);
          let parsedBody: unknown;
          try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = rawBody; }

          if (!sessionId && isInitializeRequest(parsedBody)) {
            const perReqPbServer = new PocketBaseServer();
            perReqPbServer.configureFromHeaders(req.headers);
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid) => {
                streamableTransports[sid] = transport;
              },
            });
            transport.onclose = () => {
              const sid = transport.sessionId;
              if (sid && streamableTransports[sid]) {
                delete streamableTransports[sid];
              }
            };
            await perReqPbServer.getServer().connect(transport);
            await transport.handleRequest(req, res, parsedBody);
            return;
          }

          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null,
          }));
          return;
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null,
          }));
          return;
        }

        let parsedBody: unknown;
        if (req.method === 'POST') {
          const rawBody = await readBody(req);
          try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = rawBody; }
        }
        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      const urlObj = new URL(req.url || '/', `http://localhost:${port}`);
      const sessionId = urlObj.searchParams.get('sessionId');

      if (req.method === 'POST' && sessionId) {
        const transport = pbServer.getTransportForSession(sessionId);
        if (transport) {
          await transport.handlePostMessage(req, res);
          return;
        }
      }

      if (req.method === 'GET' && req.url?.startsWith('/sse')) {
        pbServer.configureFromHeaders(req.headers);
        const transport = pbServer.createSSETransport(req, res);
        await pbServer.connectTransport(transport);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.listen(port, '0.0.0.0', () => {
      console.log(`PocketBase MCP server running on Streamable HTTP + legacy SSE (port ${port})`);
      console.log(`  Streamable HTTP: POST/GET/DELETE http://localhost:${port}/mcp`);
      console.log(`  Legacy SSE:      GET http://localhost:${port}/sse`);
    });
  } else {
    // Stdio mode - original behavior
    const pbServer = new PocketBaseServer();
    await pbServer.run();
  }
}

main().catch(console.error);
