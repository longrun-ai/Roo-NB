import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { MCPServer } from './mcp-server';
import {
    ErrorFactory,
    Logger,
    ErrorUtils,
    type ErrorContext
} from './errors';


export type SupportedIDE = 'cursor' | 'vscode' | 'unknown';

export async function getIDEType(): Promise<SupportedIDE> {
    const appName = vscode.env.appName.toLowerCase();
    if (appName.includes('cursor')) {
        return 'cursor';
    }
    if (appName.includes('code')) {
        return 'vscode';
    }
    return 'unknown';
}


// Global MCP server state management
let mcpServer: MCPServer | null = null;
let globalContext: vscode.ExtensionContext | null = null;
let activeWsFolder: vscode.WorkspaceFolder | null = null;

// Helper function to update active workspace folder
function updateActiveWsFolder(): vscode.WorkspaceFolder | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const newActiveFolder = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0] : null;

    if (activeWsFolder !== newActiveFolder) {
        activeWsFolder = newActiveFolder;
        Logger.info('Active workspace folder updated', {
            folderName: activeWsFolder?.name,
            folderPath: activeWsFolder?.uri.fsPath
        });
    }

    return activeWsFolder;
}

// MCP Module initialization and management functions
export function initializeMCPModule(context: vscode.ExtensionContext) {
    const operation = 'initializeMCPModule';
    globalContext = context;
    Logger.info('MCP module initialized');

    const config = vscode.workspace.getConfiguration('roo-nb');
    const mcpEnable = config.get<boolean>('mcp.enable', false);

    if (mcpEnable) {
        ErrorUtils.safeExecute(async () => {
            // Ensure MCP server is started
            const actualPort = await ensureMCPServerStarted();

            // Listen for workspace folder changes
            context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
                // Update active workspace folder (first folder)
                const previousActiveFolder = activeWsFolder;
                const newActiveFolder = updateActiveWsFolder();

                // Only configure MCP if the active workspace folder changed
                if (newActiveFolder !== previousActiveFolder) {
                    try {
                        if (newActiveFolder) {
                            Logger.info('Configuring MCP for new active workspace folder', {
                                folderName: newActiveFolder.name,
                                folderPath: newActiveFolder.uri.fsPath,
                                port: actualPort
                            });

                            await ensureConfiguredForWsFolder(newActiveFolder, actualPort, false);
                        } else {
                            Logger.info('No active workspace folder, MCP configuration cleared');
                        }
                    } catch (error) {
                        Logger.error('Failed to configure MCP for active workspace folder', error, {
                            folderName: newActiveFolder?.name,
                            folderPath: newActiveFolder?.uri.fsPath,
                            port: actualPort
                        });
                    }
                }
            }));

            // Initialize active workspace folder, configure MCP for it (no confirmation)
            if (updateActiveWsFolder()) {
                ensureConfiguredForWsFolder(activeWsFolder, actualPort, false).catch(error => {
                    Logger.error('Failed to auto-configure active workspace folder', error, {
                        folderName: activeWsFolder?.name,
                        actualPort
                    });
                });
            }
        }, operation, { operation }).catch(error => {
            Logger.error('Error initializing MCP server', error, { operation });
            ErrorUtils.showUserError(ErrorFactory.wrapError(error, 'MCP_SERVER_START_FAILED', { operation }));
        });
    }
}

export function cleanupMCPModule(): void {
    if (mcpServer) {
        Logger.info('Stopping MCP server...');
        mcpServer.stop().catch(error => {
            Logger.error('Error stopping MCP server during cleanup', error);
        });
        mcpServer = null;
    }
    globalContext = null;
    activeWsFolder = null;
}

async function ensureMCPServerStarted(): Promise<number> {
    const runningPort = mcpServer?.getPort() ?? 0;
    if (runningPort > 0) return runningPort;

    if (!globalContext) {
        throw ErrorFactory.configError('Extension context not available for MCP server initialization', { operation: 'ensureMCPServerStarted' });
    }

    // Get extension package.json from context
    const packageJSON = globalContext.extension.packageJSON;

    // Start new MCP server with OS-assigned port
    mcpServer = new MCPServer(packageJSON);
    const actualPort = await mcpServer.start();

    return actualPort;
}


export async function configureProjectMCPServer(): Promise<void> {
    const operation = 'configureProjectMCPServer';

    return ErrorUtils.safeExecute(async () => {
        // Check if any workspace folder is open
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            ErrorUtils.showUserError('No workspace folder is open. Please open a folder or workspace and then run the "Configure MCP Server" command again.');
            return;
        }

        // Always use the first workspace folder
        const wsFolder = vscode.workspace.workspaceFolders[0];

        const config = vscode.workspace.getConfiguration('roo-nb');

        // Always update the workspace scope setting to true
        await config.update('mcp.enable', true, vscode.ConfigurationTarget.Workspace);

        // Ensure MCP server is started (reuse existing if running)
        const actualPort = await ensureMCPServerStarted();

        // Configure IDE manually (includes UI treatments)
        await ensureConfiguredForWsFolder(wsFolder, actualPort, true);

    }, operation, { operation }).catch(error => {
        Logger.error('Error configuring MCP server', error, { operation });
        ErrorUtils.showUserError(ErrorFactory.wrapError(error, 'CONFIG_ERROR', { operation }));
    });
}


async function writeWorkspaceMCPConfig(workspaceFolder: vscode.WorkspaceFolder, port: number): Promise<void> {
    const context: ErrorContext = { operation: 'writeWorkspaceMCPConfig', port };
    const workspaceConfigPath = path.join(workspaceFolder.uri.fsPath, '.cursor', 'mcp.json');

    Logger.info('Writing MCP config for workspace', {
        ...context,
        workspaceName: workspaceFolder.name,
        workspacePath: workspaceFolder.uri.fsPath
    });

    const workspaceConfigDir = path.dirname(workspaceConfigPath);
    try {
        await fs.mkdir(workspaceConfigDir, { recursive: true });
    } catch (error) {
        throw ErrorFactory.configError(`Could not create workspace config directory: ${error}`, {
            ...context,
            configPath: workspaceConfigPath
        });
    }

    let workspaceConfig: Record<string, unknown> = {};
    try {
        await fs.access(workspaceConfigPath);
        const workspaceConfigData = await fs.readFile(workspaceConfigPath, 'utf8');
        workspaceConfig = JSON.parse(workspaceConfigData);
    } catch (error) {
        Logger.info('Creating new workspace Cursor MCP config file', {
            ...context,
            configPath: workspaceConfigPath
        });
    }

    // Ensure mcpServers exists
    if (!workspaceConfig.mcpServers || typeof workspaceConfig.mcpServers !== 'object') {
        workspaceConfig.mcpServers = {};
    }

    // Add or update roo-nb server configuration
    const expectedUrl = `http://127.0.0.1:${port}/mcp`;
    (workspaceConfig.mcpServers as Record<string, unknown>)['roo-nb'] = {
        url: expectedUrl
    };

    await fs.writeFile(workspaceConfigPath, JSON.stringify(workspaceConfig, null, 2));
    Logger.info('Workspace Cursor MCP configuration updated', {
        ...context,
        configPath: workspaceConfigPath,
        url: expectedUrl
    });
}

async function ensureCursorMCPConfiguration(workspaceFolder: vscode.WorkspaceFolder, port: number, showConfirmation: boolean): Promise<void> {
    const context: ErrorContext = { operation: 'ensureCursorMCPConfiguration', port };

    Logger.info('Configuring MCP for workspace', {
        ...context,
        workspaceName: workspaceFolder.name,
        workspacePath: workspaceFolder.uri.fsPath
    });

    await writeWorkspaceMCPConfig(workspaceFolder, port);

    // Show confirmation if requested
    if (showConfirmation) {
        const configPath = path.join(workspaceFolder.uri.fsPath, '.cursor', 'mcp.json');
        let message = `MCP server configured successfully on port ${port}. ` +
            `The server is now available at http://127.0.0.1:${port}/mcp\n\n` +
            `Configuration saved to: ${configPath}\n\n` +
            `Cursor should show a notification about the new MCP server. ` +
            `If you don't see it, check your MCP settings to enable the server.`;

        await vscode.window.showInformationMessage(`Roo Notebook: ${message}`);
    }
}

async function ensureVSCodeMCPConfiguration(port: number, showConfirmation: boolean): Promise<void> {
    const context: ErrorContext = { operation: 'ensureVSCodeMCPConfiguration', port };

    const mcpConfigSnippet = `{
  "mcpServers": {
    "roo-nb": {
      "url": "http://127.0.0.1:${port}/mcp"
    }
  }
}`;

    if (showConfirmation) {
        const copyAction = 'Copy Configuration';
        const result = await vscode.window.showInformationMessage(
            `Roo Notebook: MCP server started on port ${port}. ` +
            `VS Code doesn't have native MCP support yet. If you're using an MCP-compatible extension, ` +
            `add this configuration to your project's MCP configuration file:`,
            copyAction
        );

        if (result === copyAction) {
            await vscode.env.clipboard.writeText(mcpConfigSnippet);
            ErrorUtils.showUserInfo('MCP configuration copied to clipboard');
        }
    }

    Logger.info('VS Code MCP configuration instructions provided', context);
}

async function ensureGenericMCPConfiguration(port: number, showConfirmation: boolean): Promise<void> {
    const context: ErrorContext = { operation: 'ensureGenericMCPConfiguration', port };

    const mcpConfigSnippet = `{
  "mcpServers": {
    "roo-nb": {
      "url": "http://127.0.0.1:${port}/mcp"
    }
  }
}`;

    if (showConfirmation) {
        const copyAction = 'Copy Configuration';
        const result = await vscode.window.showWarningMessage(
            `Roo Notebook: MCP server started on port ${port}, but automatic IDE configuration failed. ` +
            `Please manually add this to your project's MCP configuration file:`,
            copyAction
        );

        if (result === copyAction) {
            await vscode.env.clipboard.writeText(mcpConfigSnippet);
            ErrorUtils.showUserInfo('MCP configuration copied to clipboard');
        }
    } else {
        Logger.warn("Unsupported IDE for auto MCP configuration", context);
    }
}

export async function ensureConfiguredForWsFolder(
    workspaceFolder: vscode.WorkspaceFolder | null,
    port: number,
    showConfirmation: boolean = false
): Promise<void> {
    const operation = 'ensureConfiguredForWsFolder';
    const context: ErrorContext = {
        operation,
        port,
        workspaceName: workspaceFolder?.name,
        showConfirmation
    };

    Logger.operationStart(operation, context);

    const ideType = await getIDEType();

    try {
        switch (ideType) {
            case 'cursor':
                if (workspaceFolder) {
                    await ensureCursorMCPConfiguration(workspaceFolder, port, showConfirmation);
                } else {
                    Logger.info('Cursor MCP configuration skipped - no workspace folder', context);
                }
                break;
            case 'vscode':
                await ensureVSCodeMCPConfiguration(port, showConfirmation);
                break;
            default:
                await ensureGenericMCPConfiguration(port, showConfirmation);
                break;
        }

        Logger.operationSuccess(operation, context);
    } catch (configError) {
        Logger.operationFailure(operation, configError, context);

        if (showConfirmation) {
            ErrorUtils.showUserWarning(
                `MCP server started on port ${port}, but IDE configuration failed. ` +
                `Please configure manually: http://127.0.0.1:${port}/mcp`
            );
        }

        throw ErrorFactory.wrapError(configError, 'IDE_CONFIG_FAILED', context);
    }
}
