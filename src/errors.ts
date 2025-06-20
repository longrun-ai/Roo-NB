/**
 * Centralized error handling and logging utilities for Roo Notebook
 * 
 * This module provides consistent error handling, logging, and formatting
 * for different audiences: users, AI agents, and developers.
 */

import * as vscode from 'vscode';

/**
 * Error codes for different types of errors
 */
export const ErrorCodes = {
  // Validation errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_PARAMETER: 'INVALID_PARAMETER',
  SCHEMA_VALIDATION_FAILED: 'SCHEMA_VALIDATION_FAILED',

  // Notebook-specific errors
  NO_ACTIVE_NOTEBOOK: 'NO_ACTIVE_NOTEBOOK',
  INDEX_OUT_OF_BOUNDS: 'INDEX_OUT_OF_BOUNDS',
  CELL_OPERATION_FAILED: 'CELL_OPERATION_FAILED',
  NOTEBOOK_SAVE_FAILED: 'NOTEBOOK_SAVE_FAILED',
  NOTEBOOK_OPEN_FAILED: 'NOTEBOOK_OPEN_FAILED',

  // Execution errors
  EXECUTION_TIMEOUT: 'EXECUTION_TIMEOUT',
  KERNEL_ERROR: 'KERNEL_ERROR',
  EXECUTION_FAILED: 'EXECUTION_FAILED',

  // System errors
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NETWORK_ERROR: 'NETWORK_ERROR',

  // MCP server errors
  MCP_SERVER_START_FAILED: 'MCP_SERVER_START_FAILED',
  MCP_SERVER_STOP_FAILED: 'MCP_SERVER_STOP_FAILED',
  MCP_TOOL_ERROR: 'MCP_TOOL_ERROR',
  MCP_TRANSPORT_ERROR: 'MCP_TRANSPORT_ERROR',

  // Configuration errors
  CONFIG_ERROR: 'CONFIG_ERROR',
  IDE_CONFIG_FAILED: 'IDE_CONFIG_FAILED',

  // Generic errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

/**
 * Context information for errors
 */
export interface ErrorContext {
  operation?: string;
  cellIndex?: number;
  cellCount?: number;
  startIndex?: number;
  stopIndex?: number;
  notebookUri?: string;
  toolName?: string;
  port?: number;
  timeout?: number;
  [key: string]: unknown;
}

/**
 * Base error class for all Roo Notebook errors
 */
export class RooNotebookError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly context?: ErrorContext,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'RooNotebookError';

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RooNotebookError);
    }
  }

  /**
   * Convert to a plain object for serialization
   */
  toObject(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      stack: this.stack,
    };
  }
}

/**
 * Logging levels
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Logger interface for consistent logging across the extension
 */
export class Logger {
  private static readonly PREFIX = 'Roo Notebook';
  private static outputChannel: vscode.OutputChannel | undefined;

  /**
   * Initialize the logger with a VS Code output channel
   */
  static initialize(outputChannel?: vscode.OutputChannel): void {
    this.outputChannel = outputChannel;
  }

  /**
   * Show the output channel in VS Code
   */
  static show(): void {
    if (this.outputChannel) {
      this.outputChannel.show();
    }
  }

  /**
   * Log debug information (for developers)
   */
  static debug(message: string, context?: ErrorContext): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      this.writeLog('DEBUG', message, context);
    }
  }

  /**
   * Log informational messages (for developers and debugging)
   */
  static info(message: string, context?: ErrorContext): void {
    if (this.shouldLog(LogLevel.INFO)) {
      this.writeLog('INFO', message, context);
    }
  }

  /**
   * Log warnings (for developers and debugging)
   */
  static warn(message: string, context?: ErrorContext): void {
    if (this.shouldLog(LogLevel.WARN)) {
      this.writeLog('WARN', message, context);
    }
  }

  /**
   * Log errors (for developers and debugging)
   */
  static error(message: string, error?: unknown, context?: ErrorContext): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      const errorInfo = error instanceof Error ?
        `Error: ${error.message}${error.stack ? '\nStack: ' + error.stack : ''}` :
        error ? `Error: ${String(error)}` : '';

      const contextInfo = context ? `\nContext: ${JSON.stringify(context, null, 2)}` : '';
      const fullMessage = `${message}${errorInfo ? '\n' + errorInfo : ''}${contextInfo}`;

      this.writeLog('ERROR', fullMessage);
    }
  }

  /**
   * Log operation start (for debugging)
   */
  static operationStart(operation: string, context?: ErrorContext): void {
    this.debug(`Starting operation: ${operation}`, context);
  }

  /**
   * Log operation success (for debugging)
   */
  static operationSuccess(operation: string, context?: ErrorContext): void {
    this.debug(`Operation completed successfully: ${operation}`, context);
  }

  /**
   * Log operation failure (for debugging)
   */
  static operationFailure(operation: string, error: unknown, context?: ErrorContext): void {
    this.error(`Operation failed: ${operation}`, error, context);
  }

  /**
   * Get the configured log level from VS Code settings
   */
  private static getConfiguredLogLevel(): LogLevel {
    const config = vscode.workspace.getConfiguration('roo-nb.logging');
    const levelString = config.get<string>('level', 'info').toLowerCase();

    switch (levelString) {
      case 'debug': return LogLevel.DEBUG;
      case 'info': return LogLevel.INFO;
      case 'warn': return LogLevel.WARN;
      case 'error': return LogLevel.ERROR;
      default: return LogLevel.INFO;
    }
  }

  /**
   * Check if we should log at the given level
   */
  private static shouldLog(level: LogLevel): boolean {
    const configuredLevel = this.getConfiguredLogLevel();
    return level >= configuredLevel;
  }

  /**
 * Write log message to both console and output channel
 */
  private static writeLog(level: string, message: string, context?: ErrorContext): void {
    const timestamp = new Date().toISOString();

    // Console logging with structural data for developer inspection
    const consoleMessage = `${this.PREFIX}: ${message}`;
    switch (level) {
      case 'DEBUG':
        if (context) {
          console.debug(consoleMessage, context);
        } else {
          console.debug(consoleMessage);
        }
        break;
      case 'INFO':
        if (context) {
          console.log(consoleMessage, context);
        } else {
          console.log(consoleMessage);
        }
        break;
      case 'WARN':
        if (context) {
          console.warn(consoleMessage, context);
        } else {
          console.warn(consoleMessage);
        }
        break;
      case 'ERROR':
        if (context) {
          console.error(consoleMessage, context);
        } else {
          console.error(consoleMessage);
        }
        break;
    }

    // Output channel logging without prefix (channel is already named "Roo Notebook")
    if (this.outputChannel) {
      const outputMessage = `[${timestamp}] ${level}: ${message}`;
      this.outputChannel.appendLine(outputMessage);
    }
  }
}

/**
 * Error formatter for different audiences
 */
export class ErrorFormatter {
  /**
   * Format error for end users (user-friendly, actionable)
   */
  static forUser(error: unknown): string {
    if (error instanceof RooNotebookError) {
      switch (error.code) {
        case ErrorCodes.NO_ACTIVE_NOTEBOOK:
          return 'No notebook is currently open. Please open a notebook first.';

        case ErrorCodes.INDEX_OUT_OF_BOUNDS:
          const { cellIndex, cellCount } = error.context || {};
          if (typeof cellIndex === 'number' && typeof cellCount === 'number') {
            return `Cell index ${cellIndex} is invalid. Valid range is 0-${cellCount - 1}.`;
          }
          return 'The specified cell index is out of bounds.';

        case ErrorCodes.EXECUTION_TIMEOUT:
          const { timeout } = error.context || {};
          return `Cell execution timed out after ${timeout || 30} seconds.`;

        case ErrorCodes.NOTEBOOK_SAVE_FAILED:
          return 'Failed to save the notebook. Please check file permissions and try again.';

        case ErrorCodes.NOTEBOOK_OPEN_FAILED:
          return 'Failed to open the notebook. Please check the file path and try again.';

        case ErrorCodes.MCP_SERVER_START_FAILED:
          return 'Failed to start the MCP server. Please check the extension settings.';

        case ErrorCodes.CONFIG_ERROR:
          return 'Configuration error. Please check your extension settings.';

        default:
          return error.message || 'An error occurred while processing your request.';
      }
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'An unexpected error occurred.';
  }

  /**
   * Format error for AI agents (structured, detailed)
   */
  static forAgent(error: unknown): string {
    if (error instanceof RooNotebookError) {
      const context = error.context ? ` Context: ${JSON.stringify(error.context)}` : '';
      return `Error [${error.code}]: ${error.message}${context}`;
    }

    if (error instanceof Error) {
      return `Error: ${error.message}`;
    }

    return `Error: ${String(error)}`;
  }

  /**
   * Format error for developers (full details, stack trace)
   */
  static forDeveloper(error: unknown): string {
    if (error instanceof RooNotebookError) {
      const parts = [
        `RooNotebookError [${error.code}]: ${error.message}`,
        error.context ? `Context: ${JSON.stringify(error.context, null, 2)}` : null,
        error.cause ? `Cause: ${String(error.cause)}` : null,
        error.stack ? `Stack: ${error.stack}` : null,
      ].filter(Boolean);

      return parts.join('\n');
    }

    if (error instanceof Error) {
      return error.stack || error.message;
    }

    return String(error);
  }
}

/**
 * Error factory functions for common error scenarios
 */
export class ErrorFactory {
  static validationError(message: string, context?: ErrorContext): RooNotebookError {
    return new RooNotebookError(message, ErrorCodes.VALIDATION_ERROR, context);
  }

  static noActiveNotebook(operation?: string): RooNotebookError {
    return new RooNotebookError(
      'No active notebook editor found',
      ErrorCodes.NO_ACTIVE_NOTEBOOK,
      { operation }
    );
  }

  static indexOutOfBounds(index: number, maxIndex: number, operation?: string): RooNotebookError {
    return new RooNotebookError(
      `Index ${index} is out of bounds (0-${maxIndex})`,
      ErrorCodes.INDEX_OUT_OF_BOUNDS,
      { cellIndex: index, cellCount: maxIndex + 1, operation }
    );
  }

  static rangeOutOfBounds(startIndex: number, stopIndex: number, cellCount: number, operation?: string): RooNotebookError {
    return new RooNotebookError(
      `Range ${startIndex}-${stopIndex} is invalid for ${cellCount} cells`,
      ErrorCodes.INDEX_OUT_OF_BOUNDS,
      { startIndex, stopIndex, cellCount, operation }
    );
  }

  static executionTimeout(timeout: number, operation?: string): RooNotebookError {
    return new RooNotebookError(
      `Execution timed out after ${timeout} seconds`,
      ErrorCodes.EXECUTION_TIMEOUT,
      { timeout, operation }
    );
  }

  static mcpServerError(message: string, port?: number, cause?: unknown): RooNotebookError {
    return new RooNotebookError(
      message,
      ErrorCodes.MCP_SERVER_START_FAILED,
      { port },
      cause
    );
  }

  static configError(message: string, context?: ErrorContext): RooNotebookError {
    return new RooNotebookError(message, ErrorCodes.CONFIG_ERROR, context);
  }

  static toolError(toolName: string, message: string, context?: ErrorContext): RooNotebookError {
    return new RooNotebookError(
      message,
      ErrorCodes.MCP_TOOL_ERROR,
      { toolName, ...context }
    );
  }

  static wrapError(error: unknown, code: ErrorCode, context?: ErrorContext): RooNotebookError {
    if (error instanceof RooNotebookError) {
      return error;
    }

    const message = error instanceof Error ? error.message : String(error);
    return new RooNotebookError(message, code, context, error);
  }
}

/**
 * Utility functions for error handling
 */
export class ErrorUtils {
  /**
   * Safely execute an async operation with error handling
   */
  static async safeExecute<T>(
    operation: () => Promise<T>,
    operationName: string,
    context?: ErrorContext
  ): Promise<T> {
    Logger.operationStart(operationName, context);

    try {
      const result = await operation();
      Logger.operationSuccess(operationName, context);
      return result;
    } catch (error) {
      Logger.operationFailure(operationName, error, context);
      throw error;
    }
  }

  /**
   * Show user-friendly error message in VS Code
   */
  static showUserError(error: unknown): void {
    const message = ErrorFormatter.forUser(error);
    vscode.window.showErrorMessage(`Roo Notebook: ${message}`);
  }

  /**
   * Show user-friendly warning message in VS Code
   */
  static showUserWarning(message: string): void {
    vscode.window.showWarningMessage(`Roo Notebook: ${message}`);
  }

  /**
   * Show user-friendly info message in VS Code
   */
  static showUserInfo(message: string): void {
    vscode.window.showInformationMessage(`Roo Notebook: ${message}`);
  }
}

/**
 * Configuration validation utilities
 */
export class ConfigValidator {
  /**
   * Validates and returns a numeric configuration value within bounds
   */
  static getNumericConfig(
    config: vscode.WorkspaceConfiguration,
    key: string,
    defaultValue: number,
    min?: number,
    max?: number,
    context?: ErrorContext
  ): number {
    const value = config.get<number>(key, defaultValue);

    if (typeof value !== 'number' || isNaN(value)) {
      Logger.warn(`Invalid numeric config value for ${key}, using default`, {
        ...context,
        key,
        value,
        defaultValue
      });
      return defaultValue;
    }

    if (min !== undefined && value < min) {
      Logger.warn(`Config value for ${key} below minimum, clamping to ${min}`, {
        ...context,
        key,
        value,
        min
      });
      return min;
    }

    if (max !== undefined && value > max) {
      Logger.warn(`Config value for ${key} above maximum, clamping to ${max}`, {
        ...context,
        key,
        value,
        max
      });
      return max;
    }

    return value;
  }

  /**
   * Gets and validates all notebook-related configuration values
   */
  static getNotebookSettings(context?: ErrorContext): {
    maxOutputSize: number;
    timeoutSeconds: number;
  } {
    const config = vscode.workspace.getConfiguration('roo-nb');

    return {
      maxOutputSize: this.getNumericConfig(
        config,
        'maxOutputSize',
        2000,
        100,
        50000,
        { ...context, setting: 'maxOutputSize' }
      ),
      timeoutSeconds: this.getNumericConfig(
        config,
        'timeoutSeconds',
        30,
        5,
        300,
        { ...context, setting: 'timeoutSeconds' }
      )
    };
  }

  /**
   * Gets and validates MCP server configuration values
   */
  static getMCPSettings(context?: ErrorContext): {
    requestTimeoutSeconds: number;
    maxRequestSizeMB: number;
  } {
    const config = vscode.workspace.getConfiguration('roo-nb');

    return {
      requestTimeoutSeconds: this.getNumericConfig(
        config,
        'mcp.requestTimeoutSeconds',
        600,
        30,
        3600,
        { ...context, setting: 'mcp.requestTimeoutSeconds' }
      ),
      maxRequestSizeMB: this.getNumericConfig(
        config,
        'mcp.maxRequestSizeMB',
        10,
        1,
        100,
        { ...context, setting: 'mcp.maxRequestSizeMB' }
      )
    };
  }
} 
