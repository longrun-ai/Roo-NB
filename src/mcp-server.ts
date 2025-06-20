import * as vscode from 'vscode';
import * as http from 'http';
import * as path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { NotebookService } from './notebook';
import { z } from 'zod';
import {
    ErrorFactory,
    Logger,
    ErrorCodes,
    ErrorUtils,
    ConfigValidator,
    type ErrorContext
} from './errors';
import { vsclmJsonSchemaToZod } from './vsclmt-schema';


interface PackageJSON {
    name: string;
    version: string;
    contributes: {
        languageModelTools: Array<{
            name: string;
            displayName: string;
            modelDescription: string;
            inputSchema?: any;
        }>;
    };
}

export class MCPServer {
    private server: Server;
    private httpServer: http.Server | null = null;
    private port: number = 0;
    private packageJSON: PackageJSON;
    private transport: StreamableHTTPServerTransport | null = null;
    private toolSchemas: Map<string, z.ZodTypeAny> = new Map();

    constructor(packageJSON: PackageJSON) {
        this.packageJSON = packageJSON;
        this.initializeToolSchemas();
        this.server = new Server(
            {
                name: packageJSON.name,
                version: packageJSON.version,
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );

        this.setupToolHandlers();
    }

    private initializeToolSchemas() {
        Logger.info('Initializing tool schemas from package.json');

        for (const tool of this.packageJSON.contributes.languageModelTools) {
            if (tool.inputSchema) {
                try {
                    const zodSchema = vsclmJsonSchemaToZod(tool.inputSchema);
                    this.toolSchemas.set(tool.name, zodSchema);
                    Logger.debug('Generated Zod schema for tool', { toolName: tool.name });
                } catch (error) {
                    Logger.warn('Failed to generate Zod schema for tool', { toolName: tool.name, error });
                }
            }
        }
    }

    private validateToolParams(toolName: string, args: unknown): any {
        const schema = this.toolSchemas.get(toolName);
        if (!schema) {
            // No schema defined - return args as-is
            return args;
        }

        try {
            return schema.parse(args);
        } catch (error) {
            if (error instanceof z.ZodError) {
                const errorDetails = error.errors.map(err =>
                    `${err.path.join('.')}: ${err.message}`
                ).join(', ');
                throw ErrorFactory.validationError(`Invalid parameters for ${toolName}: ${errorDetails}`, { toolName });
            }
            throw ErrorFactory.wrapError(error, ErrorCodes.SCHEMA_VALIDATION_FAILED, { toolName });
        }
    }

    private setupToolHandlers() {
        // List tools handler
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tools: Tool[] = this.packageJSON.contributes.languageModelTools.map(tool => ({
                name: tool.name,
                description: tool.modelDescription,
                inputSchema: tool.inputSchema || {
                    type: 'object',
                    properties: {},
                    additionalProperties: false,
                },
            }));

            return { tools };
        });

        // Call tool handler
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const context: ErrorContext = { toolName: name, operation: 'handleToolCall' };

            Logger.debug('Handling tool call', context);

            try {
                const result = await this.handleToolCall(name, args || {});
                return {
                    content: [{ type: 'text', text: result }],
                };
            } catch (error) {
                Logger.error('Tool call failed', error, context);
                return {
                    content: [{ type: 'text', text: `Error [${error instanceof Error ? error.constructor.name : 'Unknown'}]: ${error instanceof Error ? error.message : String(error)}` }],
                    isError: true,
                };
            }
        });
    }

    private async handleToolCall(toolName: string, args: any): Promise<string> {
        const context: ErrorContext = { toolName, operation: 'handleToolCall' };

        return ErrorUtils.safeExecute(async () => {
            // Get validated configuration values
            const settings = ConfigValidator.getNotebookSettings(context);
            const { maxOutputSize, timeoutSeconds } = settings;

            // Validate parameters using generated Zod schema
            const validatedParams = this.validateToolParams(toolName, args);

            switch (toolName) {
                case 'get_notebook_info':
                    return await NotebookService.getNotebookInfo();

                case 'get_notebook_cells':
                    return await NotebookService.getCells(maxOutputSize);

                case 'insert_notebook_cells': {
                    const { cells, insert_position, noexec } = validatedParams;
                    return await NotebookService.insertCells(cells, insert_position, noexec || false, maxOutputSize, timeoutSeconds);
                }

                case 'replace_notebook_cells': {
                    const { start_index, stop_index, cells, noexec } = validatedParams;
                    return await NotebookService.replaceCells(
                        (cellCount) => {
                            // Custom validation with runtime context
                            if (start_index < 0 || start_index >= cellCount) {
                                throw ErrorFactory.rangeOutOfBounds(start_index, stop_index, cellCount, toolName);
                            }
                            if (stop_index <= start_index || stop_index > cellCount) {
                                throw ErrorFactory.rangeOutOfBounds(start_index, stop_index, cellCount, toolName);
                            }
                            return { startIndex: start_index, stopIndex: stop_index, cells };
                        },
                        noexec || false,
                        maxOutputSize,
                        timeoutSeconds
                    );
                }

                case 'modify_notebook_cell_content': {
                    const { cell_index, content, noexec } = validatedParams;
                    return await NotebookService.modifyCellContent(
                        (cellCount) => {
                            if (cell_index < 0 || cell_index >= cellCount) {
                                throw ErrorFactory.indexOutOfBounds(cell_index, cellCount - 1, toolName);
                            }
                            return cell_index;
                        },
                        content,
                        noexec || false,
                        maxOutputSize,
                        timeoutSeconds
                    );
                }

                case 'execute_notebook_cells': {
                    const { start_index, stop_index } = validatedParams;
                    return await NotebookService.executeCells(
                        (cellCount) => {
                            if (start_index < 0 || start_index >= cellCount) {
                                throw ErrorFactory.rangeOutOfBounds(start_index, stop_index, cellCount, toolName);
                            }
                            if (stop_index <= start_index || stop_index > cellCount) {
                                throw ErrorFactory.rangeOutOfBounds(start_index, stop_index, cellCount, toolName);
                            }
                            return { startIndex: start_index, stopIndex: stop_index };
                        },
                        maxOutputSize,
                        timeoutSeconds
                    );
                }

                case 'delete_notebook_cells': {
                    const { start_index, stop_index } = validatedParams;
                    return await NotebookService.deleteCells(
                        (cellCount) => {
                            if (start_index < 0 || start_index >= cellCount) {
                                throw ErrorFactory.rangeOutOfBounds(start_index, stop_index, cellCount, toolName);
                            }
                            if (stop_index <= start_index || stop_index > cellCount) {
                                throw ErrorFactory.rangeOutOfBounds(start_index, stop_index, cellCount, toolName);
                            }
                            return { startIndex: start_index, stopIndex: stop_index };
                        }
                    );
                }

                case 'save_notebook':
                    return await NotebookService.saveNotebook();

                case 'open_notebook': {
                    const { path: notebookPath } = validatedParams;

                    let notebookUri: vscode.Uri;

                    // Handle absolute vs relative paths
                    if (path.isAbsolute(notebookPath)) {
                        notebookUri = vscode.Uri.file(notebookPath);
                    } else {
                        // For relative paths, need workspace context
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (!workspaceFolders || workspaceFolders.length === 0) {
                            throw ErrorFactory.validationError('No workspace open. Please use an absolute path or open a workspace.', context);
                        }
                        if (workspaceFolders.length > 1) {
                            throw ErrorFactory.validationError('Multiple workspace folders detected. Please use an absolute path to specify which notebook to open.', context);
                        }
                        notebookUri = vscode.Uri.joinPath(workspaceFolders[0].uri, notebookPath);
                    }

                    const notebook = await vscode.workspace.openNotebookDocument(notebookUri);
                    const editor = await vscode.window.showNotebookDocument(notebook, { preview: false });
                    const kernelSpec = editor.notebook.metadata?.metadata?.kernelspec;
                    const notebookInfo = {
                        uri: notebook.uri.toString(),
                        notebookType: notebook.notebookType,
                        isDirty: notebook.isDirty,
                        kernelLanguage: kernelSpec?.language,
                        kernelName: kernelSpec ? `${kernelSpec.display_name} (${kernelSpec.name})` : undefined,
                        cellCount: notebook.cellCount
                    };
                    return JSON.stringify({
                        status: 'success',
                        message: `Notebook opened and activated: ${notebookPath}`,
                        notebook: notebookInfo
                    }, null, 2);
                }

                default:
                    throw ErrorFactory.toolError(toolName, `Unknown tool: ${toolName}`);
            }
        }, `handleToolCall-${toolName}`, context);
    }

    async start(): Promise<number> {
        const context: ErrorContext = { operation: 'start MCP server' };

        return ErrorUtils.safeExecute(async () => {
            return new Promise<number>((resolve, reject) => {
                // Get validated configuration values
                const mcpSettings = ConfigValidator.getMCPSettings(context);
                const { requestTimeoutSeconds, maxRequestSizeMB } = mcpSettings;

                const requestTimeoutMs = requestTimeoutSeconds * 1000;
                const maxSize = maxRequestSizeMB * 1024 * 1024;

                Logger.info('Starting MCP server', {
                    ...context,
                    requestTimeoutSeconds,
                    maxRequestSizeMB
                });

                this.httpServer = http.createServer(async (req, res) => {
                    // Wrap each request in error boundary
                    try {
                        await this.handleHttpRequest(req, res, requestTimeoutMs, maxSize);
                    } catch (error) {
                        Logger.error('Unhandled error in HTTP request handler', error, {
                            ...context,
                            url: req.url,
                            method: req.method
                        });

                        // Ensure response is sent if not already sent
                        if (!res.headersSent) {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                jsonrpc: '2.0',
                                error: {
                                    code: -32603,
                                    message: 'Internal server error',
                                },
                                id: null,
                            }));
                        }
                    }
                });

                // Set up error handler before listen
                this.httpServer.on('error', (err: any) => {
                    Logger.error('HTTP server error', err, context);
                    reject(ErrorFactory.mcpServerError('MCP server startup failed', undefined, err));
                });

                // Listen with proper promise handling
                this.httpServer.listen(0, '127.0.0.1', () => {
                    // Wrap the callback in try-catch to ensure promise resolution
                    try {
                        this.initializeTransport()
                            .then(() => {
                                const address = this.httpServer?.address();
                                if (typeof address === 'object' && address && address.port) {
                                    this.port = address.port;
                                    Logger.info('MCP server started successfully', { ...context, port: this.port });
                                    resolve(this.port);
                                } else {
                                    reject(ErrorFactory.mcpServerError('Failed to get MCP server http port', this.port));
                                }
                            })
                            .catch((error) => {
                                reject(ErrorFactory.mcpServerError('Failed to initialize MCP transport', this.port, error));
                            });
                    } catch (error) {
                        reject(ErrorFactory.mcpServerError('Error in server listen callback', this.port, error));
                    }
                });
            });
        }, 'startMCPServer', context);
    }

    /**
     * Handles individual HTTP requests with proper error boundaries
     */
    private async handleHttpRequest(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        requestTimeoutMs: number,
        maxSize: number
    ): Promise<void> {
        const context: ErrorContext = {
            operation: 'handleHttpRequest',
            url: req.url,
            method: req.method
        };

        let timeoutHandle: NodeJS.Timeout | null = null;

        try {
            return await ErrorUtils.safeExecute(async () => {
                // Set request timeout with proper error handling
                timeoutHandle = setTimeout(() => {
                    if (!res.headersSent) {
                        Logger.warn('Request timeout', { ...context, timeout: requestTimeoutMs });
                        res.writeHead(408, { 'Content-Type': 'text/plain' });
                        res.end('Request timeout');
                    }
                }, requestTimeoutMs);

                try {
                    // Set response headers
                    res.setHeader('Content-Type', 'application/json');

                    if (req.method === 'OPTIONS') {
                        res.writeHead(200);
                        res.end();
                        return;
                    }

                    // Only handle requests to /mcp endpoint
                    if (req.url !== '/mcp') {
                        res.writeHead(404, { 'Content-Type': 'text/plain' });
                        res.end('Not Found');
                        return;
                    }

                    if (req.method !== 'POST') {
                        res.writeHead(405, { 'Content-Type': 'text/plain' });
                        res.end('Method not allowed');
                        return;
                    }

                    // Parse request body with proper error handling
                    let body: string;
                    try {
                        body = await this.parseRequestBody(req, maxSize, context);
                    } catch (parseError) {
                        Logger.error('Error parsing request body', parseError, context);
                        if (!res.headersSent) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                jsonrpc: '2.0',
                                error: {
                                    code: -32700,
                                    message: 'Request body parse error',
                                },
                                id: null,
                            }));
                        }
                        return;
                    }

                    let requestBody: any;
                    try {
                        requestBody = JSON.parse(body);
                    } catch (parseError) {
                        Logger.warn('JSON parse error', { ...context, error: parseError });
                        if (!res.headersSent) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                jsonrpc: '2.0',
                                error: {
                                    code: -32700,
                                    message: 'Parse error',
                                },
                                id: null,
                            }));
                        }
                        return;
                    }

                    // Handle the MCP request
                    if (!this.transport) {
                        throw ErrorFactory.mcpServerError('MCP transport not initialized');
                    }

                    try {
                        await this.transport.handleRequest(req, res, requestBody);
                    } catch (transportError) {
                        Logger.error('Transport error handling request', transportError, context);
                        if (!res.headersSent) {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                jsonrpc: '2.0',
                                error: {
                                    code: -32603,
                                    message: 'Internal error',
                                },
                                id: requestBody?.id || null,
                            }));
                        }
                    }
                } finally {
                    if (timeoutHandle) {
                        clearTimeout(timeoutHandle);
                        timeoutHandle = null;
                    }
                }
            }, 'handleHttpRequest', context);
        } catch (outerError) {
            // Final safety net for any unhandled errors
            Logger.error('Unhandled error in HTTP request handler', outerError, context);
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            if (!res.headersSent) {
                try {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Internal Server Error');
                } catch (responseError) {
                    Logger.error('Error sending error response', responseError, context);
                }
            }
        }
    }

    /**
     * Parses request body with size limits and proper error handling
     */
    private async parseRequestBody(
        req: http.IncomingMessage,
        maxSize: number,
        context: ErrorContext
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            let body = '';
            let bodySize = 0;
            let sizeExceeded = false;
            let resolved = false;

            const cleanup = () => {
                if (req.readable) {
                    req.removeAllListeners('data');
                    req.removeAllListeners('end');
                    req.removeAllListeners('error');
                }
            };

            const safeResolve = (value: string) => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    resolve(value);
                }
            };

            const safeReject = (error: Error) => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    reject(error);
                }
            };

            // Handle request errors
            req.on('error', (error) => {
                Logger.error('Request stream error', error, context);
                safeReject(ErrorFactory.mcpServerError('Request stream error', undefined, error));
            });

            // Handle data chunks
            req.on('data', (chunk) => {
                try {
                    // Check if already resolved/rejected
                    if (resolved) {
                        return;
                    }

                    bodySize += chunk.length;
                    if (bodySize > maxSize) {
                        if (!sizeExceeded) {
                            sizeExceeded = true;
                            safeReject(ErrorFactory.mcpServerError(`Request too large: ${bodySize} bytes (max: ${maxSize})`));
                        }
                        return;
                    }

                    // Safe string conversion with error handling
                    const chunkString = chunk.toString('utf8');
                    body += chunkString;
                } catch (error) {
                    Logger.error('Error processing request chunk', error, context);
                    safeReject(ErrorFactory.mcpServerError('Error processing request data', undefined, error));
                }
            });

            // Handle end of request
            req.on('end', () => {
                if (!sizeExceeded && !resolved) {
                    safeResolve(body);
                }
            });

            // Handle client disconnection/abort
            req.on('close', () => {
                if (!resolved) {
                    Logger.debug('Request closed by client', context);
                    safeReject(ErrorFactory.mcpServerError('Request closed by client'));
                }
            });
        });
    }

    /**
     * Initializes the MCP transport with proper error handling
     */
    private async initializeTransport(): Promise<void> {
        const context: ErrorContext = { operation: 'initializeTransport' };

        return ErrorUtils.safeExecute(async () => {
            // Initialize the singleton transport
            this.transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined, // stateless mode
            });

            // Connect MCP server to the singleton transport
            await this.server.connect(this.transport);

            Logger.debug('MCP transport initialized successfully', context);
        }, 'initializeTransport', context);
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            // Clean up the singleton transport first
            if (this.transport) {
                try {
                    this.transport.close();
                    this.transport = null;
                } catch (error) {
                    Logger.error('Error closing transport during shutdown', error);
                }
            }

            if (!this.httpServer) {
                resolve();
                return;
            }

            // Set a timeout for server shutdown
            const shutdownTimeout = setTimeout(() => {
                Logger.warn('MCP server shutdown timed out, forcing close');
                this.httpServer?.closeAllConnections?.();
                this.httpServer = null;
                resolve();
            }, 5000); // 5 second timeout

            this.httpServer.close((err) => {
                clearTimeout(shutdownTimeout);
                if (err) {
                    Logger.error('Error stopping MCP server', err);
                    // Don't reject, just log the error and clean up
                }
                Logger.info('MCP server stopped');
                this.httpServer = null;
                resolve();
            });

            // Close all connections immediately to speed up shutdown
            this.httpServer.closeAllConnections?.();
        });
    }

    getPort(): number {
        return this.port;
    }
}
