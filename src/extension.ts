import * as vscode from 'vscode';
import * as path from 'path';
import { NotebookService } from './notebook';
import {
  initializeMCPModule,
  configureProjectMCPServer,
  cleanupMCPModule
} from './mcp-config';
import {
  ErrorFactory,
  ErrorFormatter,
  Logger,
  ErrorUtils,
  ConfigValidator
} from './errors';

abstract class BaseNotebookTool<T> {
  abstract name: string;
  abstract displayName: string;

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<T>,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: `Invoking ${this.displayName}`,
    };
  }

  abstract invoke(
    options: vscode.LanguageModelToolInvocationOptions<T>,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.LanguageModelToolResult>;

  register(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.lm.registerTool(this.name, this));
  }

  protected createToolResult(text: string, isError = false): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(text)
    ]);
  }

  protected getNbSettings() {
    return ConfigValidator.getNotebookSettings({ operation: this.name });
  }
}

// Tool implementations
class GetNotebookInfoTool extends BaseNotebookTool<void> {
  name = 'get_notebook_info';
  displayName = 'Get Notebook Info';

  async invoke(_options: vscode.LanguageModelToolInvocationOptions<void>, _token: vscode.CancellationToken) {
    return ErrorUtils.safeExecute(async () => {
      const info = await NotebookService.getNotebookInfo();
      return this.createToolResult(info);
    }, this.name, { toolName: this.name })
      .catch(error => {
        Logger.error('Tool execution failed', error, { toolName: this.name });
        return this.createToolResult(`Error getting notebook info: ${ErrorFormatter.forAgent(error)}`, true);
      });
  }
}

class GetNotebookCellsTool extends BaseNotebookTool<void> {
  name = 'get_notebook_cells';
  displayName = 'Get Notebook Cells';

  async invoke(_options: vscode.LanguageModelToolInvocationOptions<void>, _token: vscode.CancellationToken) {
    return ErrorUtils.safeExecute(async () => {
      const settings = this.getNbSettings();
      const cells = await NotebookService.getCells(settings.maxOutputSize);
      return this.createToolResult(cells);
    }, this.name, { toolName: this.name })
      .catch(error => {
        Logger.error('Tool execution failed', error, { toolName: this.name });
        return this.createToolResult(`Error getting notebook cells: ${ErrorFormatter.forAgent(error)}`, true);
      });
  }
}

interface InsertNotebookCellsInput {
  cells: Array<{
    content: string;
    cell_type?: string;
    language_id?: string;
  }>;
  insert_position?: number;
  noexec?: boolean;
}

class InsertNotebookCellsTool extends BaseNotebookTool<InsertNotebookCellsInput> {
  name = 'insert_notebook_cells';
  displayName = 'Insert Notebook Cells';

  async invoke(options: vscode.LanguageModelToolInvocationOptions<InsertNotebookCellsInput>, _token: vscode.CancellationToken) {
    return ErrorUtils.safeExecute(async () => {
      const { cells, insert_position, noexec } = options.input;

      // Basic validation - VS Code LM framework handles JSON schema validation
      if (!cells || !Array.isArray(cells)) {
        throw ErrorFactory.validationError('Parameter "cells" must be an array', { toolName: this.name });
      }

      const settings = this.getNbSettings();
      const result = await NotebookService.insertCells(
        cells,
        insert_position,
        noexec,
        settings.maxOutputSize,
        settings.timeoutSeconds
      );
      return this.createToolResult(result);
    }, this.name, { toolName: this.name })
      .catch(error => {
        Logger.error('Tool execution failed', error, { toolName: this.name });
        return this.createToolResult(`Error inserting cells: ${ErrorFormatter.forAgent(error)}`, true);
      });
  }
}

interface ReplaceNotebookCellsInput {
  start_index: number;
  stop_index: number;
  cells: Array<{
    content: string;
    cell_type?: string;
    language_id?: string;
  }>;
  noexec?: boolean;
}

class ReplaceNotebookCellsTool extends BaseNotebookTool<ReplaceNotebookCellsInput> {
  name = 'replace_notebook_cells';
  displayName = 'Replace Notebook Cells';

  async invoke(options: vscode.LanguageModelToolInvocationOptions<ReplaceNotebookCellsInput>, _token: vscode.CancellationToken) {
    return ErrorUtils.safeExecute(async () => {
      const { start_index, stop_index, cells, noexec } = options.input;

      // Basic validation - VS Code LM framework handles JSON schema validation
      if (typeof start_index !== 'number' || typeof stop_index !== 'number') {
        throw ErrorFactory.validationError('start_index and stop_index must be numbers', { toolName: this.name });
      }
      if (!Array.isArray(cells)) {
        throw ErrorFactory.validationError('Parameter "cells" must be an array', { toolName: this.name });
      }

      const settings = this.getNbSettings();
      const result = await NotebookService.replaceCells(
        (cellCount) => {
          // Runtime validation with cell count context
          if (start_index < 0 || start_index >= cellCount) {
            throw ErrorFactory.rangeOutOfBounds(start_index, stop_index, cellCount, 'replace_notebook_cells');
          }
          if (stop_index <= start_index || stop_index > cellCount) {
            throw ErrorFactory.rangeOutOfBounds(start_index, stop_index, cellCount, 'replace_notebook_cells');
          }
          return { startIndex: start_index, stopIndex: stop_index, cells };
        },
        noexec,
        settings.maxOutputSize,
        settings.timeoutSeconds
      );
      return this.createToolResult(result);
    }, this.name, { toolName: this.name })
      .catch(error => {
        Logger.error('Tool execution failed', error, { toolName: this.name });
        return this.createToolResult(`Error replacing cells: ${ErrorFormatter.forAgent(error)}`, true);
      });
  }
}

interface ModifyNotebookCellContentInput {
  cell_index: number;
  content: string;
  noexec?: boolean;
}

class ModifyNotebookCellContentTool extends BaseNotebookTool<ModifyNotebookCellContentInput> {
  name = 'modify_notebook_cell_content';
  displayName = 'Modify Notebook Cell Content';

  async invoke(options: vscode.LanguageModelToolInvocationOptions<ModifyNotebookCellContentInput>, _token: vscode.CancellationToken) {
    return ErrorUtils.safeExecute(async () => {
      const { cell_index, content, noexec } = options.input;

      // Basic validation - VS Code LM framework handles JSON schema validation
      if (typeof cell_index !== 'number' || typeof content !== 'string') {
        throw ErrorFactory.validationError('cell_index must be a number and content must be a string', { toolName: this.name });
      }

      const settings = this.getNbSettings();
      const result = await NotebookService.modifyCellContent(
        (cellCount) => {
          if (cell_index < 0 || cell_index >= cellCount) {
            throw ErrorFactory.indexOutOfBounds(cell_index, cellCount - 1, 'modify_notebook_cell_content');
          }
          return cell_index;
        },
        content,
        noexec,
        settings.maxOutputSize,
        settings.timeoutSeconds
      );
      return this.createToolResult(result);
    }, this.name, { toolName: this.name })
      .catch(error => {
        Logger.error('Tool execution failed', error, { toolName: this.name });
        return this.createToolResult(`Error modifying cell content: ${ErrorFormatter.forAgent(error)}`, true);
      });
  }
}

interface ExecuteNotebookCellsInput {
  start_index: number;
  stop_index: number;
}

class ExecuteNotebookCellsTool extends BaseNotebookTool<ExecuteNotebookCellsInput> {
  name = 'execute_notebook_cells';
  displayName = 'Execute Notebook Cells';

  async invoke(options: vscode.LanguageModelToolInvocationOptions<ExecuteNotebookCellsInput>, _token: vscode.CancellationToken) {
    return ErrorUtils.safeExecute(async () => {
      const { start_index, stop_index } = options.input;

      // Basic validation - VS Code LM framework handles JSON schema validation
      if (typeof start_index !== 'number' || typeof stop_index !== 'number') {
        throw ErrorFactory.validationError('start_index and stop_index must be numbers', { toolName: this.name });
      }

      const settings = this.getNbSettings();
      const result = await NotebookService.executeCells(
        (cellCount) => {
          if (start_index < 0 || start_index >= cellCount) {
            throw ErrorFactory.rangeOutOfBounds(start_index, stop_index, cellCount, 'execute_notebook_cells');
          }
          if (stop_index <= start_index || stop_index > cellCount) {
            throw ErrorFactory.rangeOutOfBounds(start_index, stop_index, cellCount, 'execute_notebook_cells');
          }
          return { startIndex: start_index, stopIndex: stop_index };
        },
        settings.maxOutputSize,
        settings.timeoutSeconds
      );
      return this.createToolResult(result);
    }, this.name, { toolName: this.name })
      .catch(error => {
        Logger.error('Tool execution failed', error, { toolName: this.name });
        return this.createToolResult(`Error executing cells: ${ErrorFormatter.forAgent(error)}`, true);
      });
  }
}

interface DeleteNotebookCellsInput {
  start_index: number;
  stop_index: number;
}

class DeleteNotebookCellsTool extends BaseNotebookTool<DeleteNotebookCellsInput> {
  name = 'delete_notebook_cells';
  displayName = 'Delete Notebook Cells';

  async invoke(options: vscode.LanguageModelToolInvocationOptions<DeleteNotebookCellsInput>, _token: vscode.CancellationToken) {
    return ErrorUtils.safeExecute(async () => {
      const { start_index, stop_index } = options.input;

      // Basic validation - VS Code LM framework handles JSON schema validation
      if (typeof start_index !== 'number' || typeof stop_index !== 'number') {
        throw ErrorFactory.validationError('start_index and stop_index must be numbers', { toolName: this.name });
      }

      const result = await NotebookService.deleteCells(
        (cellCount) => {
          if (start_index < 0 || start_index >= cellCount) {
            throw ErrorFactory.rangeOutOfBounds(start_index, stop_index, cellCount, 'delete_notebook_cells');
          }
          if (stop_index <= start_index || stop_index > cellCount) {
            throw ErrorFactory.rangeOutOfBounds(start_index, stop_index, cellCount, 'delete_notebook_cells');
          }
          return { startIndex: start_index, stopIndex: stop_index };
        }
      );
      return this.createToolResult(result);
    }, this.name, { toolName: this.name })
      .catch(error => {
        Logger.error('Tool execution failed', error, { toolName: this.name });
        return this.createToolResult(`Error deleting cells: ${ErrorFormatter.forAgent(error)}`, true);
      });
  }
}

class SaveNotebookTool extends BaseNotebookTool<void> {
  name = 'save_notebook';
  displayName = 'Save Notebook';

  async invoke(_options: vscode.LanguageModelToolInvocationOptions<void>, _token: vscode.CancellationToken) {
    return ErrorUtils.safeExecute(async () => {
      const result = await NotebookService.saveNotebook();
      return this.createToolResult(result);
    }, this.name, { toolName: this.name })
      .catch(error => {
        Logger.error('Tool execution failed', error, { toolName: this.name });
        return this.createToolResult(`Error saving notebook: ${ErrorFormatter.forAgent(error)}`, true);
      });
  }
}

interface OpenNotebookInput {
  path: string;
}

class OpenNotebookTool extends BaseNotebookTool<OpenNotebookInput> {
  name = 'open_notebook';
  displayName = 'Open Notebook';

  async invoke(options: vscode.LanguageModelToolInvocationOptions<OpenNotebookInput>, _token: vscode.CancellationToken) {
    return ErrorUtils.safeExecute(async () => {
      const { path: notebookPath } = options.input;

      // Basic validation - VS Code LM framework handles JSON schema validation
      if (!notebookPath || typeof notebookPath !== 'string') {
        throw ErrorFactory.validationError('path must be a non-empty string', { toolName: this.name });
      }

      let notebookUri: vscode.Uri;

      // Handle absolute vs relative paths
      if (path.isAbsolute(notebookPath)) {
        notebookUri = vscode.Uri.file(notebookPath);
      } else {
        // For relative paths, need workspace context
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
          throw ErrorFactory.validationError('No workspace open. Please use an absolute path or open a workspace.', { toolName: this.name });
        }
        if (workspaceFolders.length > 1) {
          throw ErrorFactory.validationError('Multiple workspace folders detected. Please use an absolute path to specify which notebook to open.', { toolName: this.name });
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
      return this.createToolResult(JSON.stringify({
        status: 'success',
        message: `Notebook opened and activated: ${notebookPath}`,
        notebook: notebookInfo
      }, null, 2));
    }, this.name, { toolName: this.name })
      .catch(error => {
        Logger.error('Tool execution failed', error, { toolName: this.name });
        return this.createToolResult(`Error opening notebook: ${ErrorFormatter.forAgent(error)}`, true);
      });
  }
}

class RestartKernelTool extends BaseNotebookTool<void> {
  name = 'restart_kernel';
  displayName = 'Restart Kernel';

  async invoke(_options: vscode.LanguageModelToolInvocationOptions<void>, _token: vscode.CancellationToken) {
    return ErrorUtils.safeExecute(async () => {
      const result = await NotebookService.restartKernel();
      return this.createToolResult(result);
    }, this.name, { toolName: this.name })
      .catch(error => {
        Logger.error('Tool execution failed', error, { toolName: this.name });
        return this.createToolResult(`Error restarting kernel: ${ErrorFormatter.forAgent(error)}`, true);
      });
  }
}

class InterruptKernelTool extends BaseNotebookTool<void> {
  name = 'interrupt_kernel';
  displayName = 'Interrupt Kernel';

  async invoke(_options: vscode.LanguageModelToolInvocationOptions<void>, _token: vscode.CancellationToken) {
    return ErrorUtils.safeExecute(async () => {
      const result = await NotebookService.interruptKernel();
      return this.createToolResult(result);
    }, this.name, { toolName: this.name })
      .catch(error => {
        Logger.error('Tool execution failed', error, { toolName: this.name });
        return this.createToolResult(`Error interrupting kernel: ${ErrorFormatter.forAgent(error)}`, true);
      });
  }
}


export function activate(context: vscode.ExtensionContext) {
  // Conditionally create and initialize the output channel for logging
  const config = vscode.workspace.getConfiguration('roo-nb');
  const showInOutput = config.get<boolean>('logging.showInOutput', true);

  if (showInOutput) {
    Logger.ensureOutputChannel(context);
  }
  Logger.info('Extension activated');

  // Listen for configuration changes to enable output channel when logging is turned on
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('roo-nb.logging.showInOutput')) {
      const newConfig = vscode.workspace.getConfiguration('roo-nb');
      const newShowInOutput = newConfig.get<boolean>('logging.showInOutput', true);
      if (newShowInOutput) {
        Logger.ensureOutputChannel(context);
      }
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('roo-nb.showLogs', () => {
    if (Logger.showOutputChannel()) return;
    vscode.window.showInformationMessage(
      `Roo Notebook: Enable "roo-nb.logging.showInOutput" in settings to see logs in the Output panel, or use Help > Toggle Developer Tools to view console logs.`,
      'Open Settings'
    ).then(selection => {
      if (selection === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'roo-nb.logging.showInOutput');
      }
    });
  }));

  // Register MCP configuration command
  context.subscriptions.push(vscode.commands.registerCommand('roo-nb.configProjectMCPServer', async () => {
    await configureProjectMCPServer();
  }));


  // Proper LM tool registration
  const tools = [
    new GetNotebookInfoTool(),
    new GetNotebookCellsTool(),
    new InsertNotebookCellsTool(),
    new ReplaceNotebookCellsTool(),
    new ModifyNotebookCellContentTool(),
    new ExecuteNotebookCellsTool(),
    new DeleteNotebookCellsTool(),
    new SaveNotebookTool(),
    new OpenNotebookTool(),
    new RestartKernelTool(),
    new InterruptKernelTool()
  ];
  tools.forEach(tool => tool.register(context));
  Logger.info('Extension tools registered successfully');


  // Initialize MCP module (handles auto-start if enabled)
  initializeMCPModule(context);
}

export function deactivate() {
  cleanupMCPModule();
}
