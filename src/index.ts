

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import PocketBase from 'pocketbase';

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
  private pb: PocketBase;

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

    const url = process.env.POCKETBASE_URL;
    if (!url) {
      throw new Error('POCKETBASE_URL environment variable is required');
    }
    this.pb = new PocketBase(url);

    this.setupToolHandlers();

    this.server.onerror = (error: unknown) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private async adminAuth() {
    const email = process.env.POCKETBASE_ADMIN_EMAIL ?? '';
    const password = process.env.POCKETBASE_ADMIN_PASSWORD ?? '';
    if (email && password) {
      await this.pb.collection('_superusers').authWithPassword(email, password);
    } else {
      // Try anonymous auth as fallback for public collections
      try {
        await this.pb.authStore.load();
      } catch {}
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

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('PocketBase MCP server running on stdio');
  }
}

const server = new PocketBaseServer();
server.run().catch(console.error);


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

