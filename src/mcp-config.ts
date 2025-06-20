import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { 
    ErrorFactory, 
    Logger, 
    ErrorUtils,
    type ErrorContext 
} from './errors';

async function ensureCursorMCPConfiguration(port: number, showConfirmation: boolean) {
    const context: ErrorContext = { operation: 'ensureCursorMCPConfiguration', port };
    
    const homeDir = os.homedir();
    const globalConfigPath = path.join(homeDir, '.cursor', 'mcp.json');
    const workspaceConfigPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.cursor', 'mcp.json');

    let removedFromWorkspace = false;

    // Remove roo-nb from workspace config if it exists
    try {
        await fs.access(workspaceConfigPath);
        const workspaceConfigData = await fs.readFile(workspaceConfigPath, 'utf8');
        const workspaceConfig = JSON.parse(workspaceConfigData);

        if (workspaceConfig.mcpServers && workspaceConfig.mcpServers['roo-nb']) {
            delete workspaceConfig.mcpServers['roo-nb'];
            await fs.writeFile(workspaceConfigPath, JSON.stringify(workspaceConfig, null, 2));
            removedFromWorkspace = true;
            Logger.info('Removed roo-nb MCP server from workspace config', { 
                ...context, 
                configPath: workspaceConfigPath 
            });
        }
    } catch (error) {
        // Workspace config doesn't exist or can't be read - that's fine
        Logger.debug('Workspace config not found or not accessible', { ...context, error });
    }

    // Always add/update global config
    const globalConfigDir = path.dirname(globalConfigPath);
    try {
        await fs.mkdir(globalConfigDir, { recursive: true });
    } catch (error) {
        throw ErrorFactory.configError(`Could not create global config directory: ${error}`, { 
            ...context, 
            configPath: globalConfigPath 
        });
    }

    let globalConfig: Record<string, unknown> = {};
    try {
        await fs.access(globalConfigPath);
        const globalConfigData = await fs.readFile(globalConfigPath, 'utf8');
        globalConfig = JSON.parse(globalConfigData);
    } catch (error) {
        Logger.info('Creating new global Cursor MCP config file', { 
            ...context, 
            configPath: globalConfigPath 
        });
    }

    // Ensure mcpServers exists
    if (!globalConfig.mcpServers || typeof globalConfig.mcpServers !== 'object') {
        globalConfig.mcpServers = {};
    }

    // Add or update roo-nb server configuration
    const expectedUrl = `http://127.0.0.1:${port}/mcp`;
    (globalConfig.mcpServers as Record<string, unknown>)['roo-nb'] = {
        url: expectedUrl
    };

    await fs.writeFile(globalConfigPath, JSON.stringify(globalConfig, null, 2));
    Logger.info('Global Cursor MCP configuration updated', { 
        ...context, 
        configPath: globalConfigPath,
        url: expectedUrl
    });

    // Show messages
    if (removedFromWorkspace) {
        ErrorUtils.showUserInfo('Moved MCP server configuration from workspace to global settings for better reliability.');
    }

    if (showConfirmation) {
        let message = `MCP server configured successfully on port ${port}. ` +
            `The server is now available at http://127.0.0.1:${port}/mcp\n\n` +
            `Configuration saved to: ${globalConfigPath}`;

        const openConfigAction = 'Open MCP Settings';
        const userResult = await vscode.window.showInformationMessage(`Roo Notebook: ${message}`, openConfigAction);

        if (userResult === openConfigAction) {
            await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:cursor.mcp');
        }
    }
}

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

async function ensureVSCodeMCPConfiguration(port: number, showConfirmation: boolean) {
    const context: ErrorContext = { operation: 'ensureVSCodeMCPConfiguration', port };
    
    // VS Code doesn't have built-in MCP support yet, provide instructions
    const mcpConfigSnippet = `{
  "mcpServers": {
    "roo-nb": {
      "url": "http://127.0.0.1:${port}/mcp"
    }
  }
}`;

    const copyAction = 'Copy Configuration';
    const result = await vscode.window.showInformationMessage(
        `Roo Notebook: MCP server started on port ${port}. ` +
        `VS Code doesn't have native MCP support yet. If you're using an MCP-compatible extension, ` +
        `add this configuration:`,
        copyAction
    );

    if (result === copyAction) {
        await vscode.env.clipboard.writeText(mcpConfigSnippet);
        ErrorUtils.showUserInfo('MCP configuration copied to clipboard');
    }
    
    Logger.info('VS Code MCP configuration instructions provided', context);
}

export async function ensureConfigedInIDE(port: number, showConfirmation: boolean = false) {
    const operation = 'ensureConfigedInIDE';
    const context: ErrorContext = { operation, port };
    
    Logger.operationStart(operation, context);
    
    const ideType = await getIDEType();

    try {
        switch (ideType) {
            case 'cursor':
                await ensureCursorMCPConfiguration(port, showConfirmation);
                break;
            case 'vscode':
                await ensureVSCodeMCPConfiguration(port, showConfirmation);
                break;
            default:
                Logger.warn("Unsupported IDE, MCP server configuration may need to be done manually", { 
                    ...context, 
                    ideType 
                });

                const mcpConfigSnippet = `{
  "mcpServers": {
    "roo-nb": {
      "url": "http://127.0.0.1:${port}/mcp"
    }
  }
}`;

                const copyAction = 'Copy Configuration';
                const result = await vscode.window.showWarningMessage(
                    `Roo Notebook: MCP server started on port ${port}, but automatic IDE configuration failed. ` +
                    `Please manually add this to your MCP configuration file:`,
                    copyAction
                );

                if (result === copyAction) {
                    await vscode.env.clipboard.writeText(mcpConfigSnippet);
                    ErrorUtils.showUserInfo('MCP configuration copied to clipboard');
                }
                break;
        }
        
        Logger.operationSuccess(operation, context);
    } catch (configError) {
        Logger.operationFailure(operation, configError, context);
        ErrorUtils.showUserWarning(
            `MCP server started on port ${port}, but IDE configuration failed. ` +
            `Please configure manually: http://127.0.0.1:${port}/mcp`
        );
        throw ErrorFactory.wrapError(configError, 'IDE_CONFIG_FAILED', context);
    }
} 
