import * as vscode from "vscode"
import {
	RooNotebookError,
	ErrorFactory,
	Logger,
	ErrorUtils,
	type ErrorContext
} from './errors';


function isTextOutput(item: vscode.NotebookCellOutputItem): boolean {
	if (item.mime.startsWith("text/")) return true

	if (item.mime === "application/vnd.code.notebook.stdout") return true
	if (item.mime === "application/vnd.code.notebook.stderr") return true

	if (item.mime === "application/json") return true
	if (item.mime === "application/javascript") return true

	return false
}

function showCell(cell: vscode.NotebookCell, maxOutputSize: number): string {
	const cellType = cell.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code"
	let cellLanguageId = cell.document.languageId

	let result = `## Cell ${cell.index} (`
	if (cell.kind === vscode.NotebookCellKind.Code) {
		cellLanguageId = cell.document.languageId
		result += `${cellType}:${cellLanguageId}`
	} else {
		result += cellType
	}
	result += `)\n\n`

	// Handle cell content
	const cellContent = cell.document.getText()

	if (cell.kind === vscode.NotebookCellKind.Code) {
		let execLabel = " "
		if (cell.executionSummary?.executionOrder !== undefined) {
			execLabel = String(cell.executionSummary.executionOrder)
		}
		result += `### In [${execLabel}]:\n\n\`\`\`${cellLanguageId}\n${cellContent}\n\`\`\`\n\n`

		// Add output if available for code cells
		if (cell.outputs.length > 0) {
			result += `### Out [${execLabel}]:\n\n`

			// Process each output
			for (const output of cell.outputs) {
				try {
					result += `#### Output with ${output.items.length} items\n\n`

					// Try to extract textual content from outputs
					for (let i = 0; i < output.items.length; i++) {
						const item = output.items[i]
						if (isTextOutput(item)) {
							try {
								const textDecoder = new TextDecoder()
								const textContent = textDecoder.decode(item.data)

								if (textContent.length > maxOutputSize) {
									const truncatedText = textContent.substring(0, maxOutputSize - 3)
									result += `${i + 1}. Truncated text with MIME: ${item.mime}, full length: ${textContent.length} characters\n\n`
									result += `\`\`\`\n${truncatedText}...\n\`\`\`\n\n`
								} else {
									result += `${i + 1}. Text with MIME: ${item.mime}\n\n`
									result += `\`\`\`\n${textContent}\n\`\`\`\n\n`
								}
							} catch (textErr) {
								Logger.warn('Error extracting text content from cell output', {
									cellIndex: cell.index,
									outputIndex: i,
									error: textErr
								});
								result += `> Error extracting text content: ${textErr instanceof Error ? textErr.message : String(textErr)}\n\n`
							}
						} else {
							result += `${i + 1}. (Not shown) ${item.data.length} bytes with MIME: ${item.mime}\n\n`
						}
					}
				} catch (err) {
					Logger.warn('Error processing cell output', { cellIndex: cell.index, error: err });
					result += `> Error processing output: ${err instanceof Error ? err.message : String(err)}\n\n`
				}
			}
		}
	} else {
		// For markdown cells, just show the content without In/Out labels
		result += `\`\`\`${cellLanguageId}\n${cellContent}\n\`\`\`\n\n`
	}

	return result
}

/**
 * Helper that executes the specified range of cells
 *
 * @param cells The cells array from the notebook
 * @param startIndex The starting index of cells to execute
 * @param stopIndex The stopping index of cells to execute
 * @param maxOutputSize Maximum size for cell output
 * @param timeoutSeconds Maximum seconds to wait for execution
 * @returns A string containing formatted information about the executed cells
 */
async function executeNotebookCells(
	cells: vscode.NotebookCell[],
	startIndex: number,
	stopIndex: number,
	maxOutputSize: number = 2000,
	timeoutSeconds: number = 30,
): Promise<string> {
	const context: ErrorContext = {
		operation: 'executeNotebookCells',
		startIndex,
		stopIndex,
		cellCount: cells.length
	};

	Logger.operationStart('Execute notebook cells', context);

	// Get the cells to execute
	const cellsToExecute = cells.slice(startIndex, stopIndex)

	// Filter only code cells as markdown cells cannot be executed
	const codeCells = cellsToExecute.filter((cell) => cell.kind === vscode.NotebookCellKind.Code)

	if (codeCells.length === 0) {
		Logger.info('No code cells found in execution range', context);
		return `# Cell Execution\n\nNo code cells found in the specified range (${startIndex}-${stopIndex - 1}).`
	}

	// Store previous execution orders for all code cells
	const previousExecutionOrders = new Map<number, number | undefined>()
	codeCells.forEach((cell) => {
		previousExecutionOrders.set(cell.index, cell.executionSummary?.executionOrder)
	})

	// Wait for execution to complete or timeout
	const timeoutMs = timeoutSeconds * 1000
	let executionComplete = false
	const startTime = Date.now()

	// Execute the cells
	Logger.debug('Executing cells via VS Code command', { ...context, codeCellCount: codeCells.length });
	await vscode.commands.executeCommand("notebook.cell.execute", {
		start: startIndex,
		end: stopIndex,
	})

	// Poll for execution completion
	// NOTE: This polling approach is necessary due to VS Code Notebook API limitations.
	// There's no direct event-based mechanism to detect when all cells have completed execution.
	// The timeout provides a safety guard against infinite waiting, though race conditions 
	// may still occur with rapidly executing cells or kernel communication delays.
	let allComplete = true
	while (!executionComplete && Date.now() - startTime < timeoutMs) {
		// Check if execution orders have changed for all cells, indicating completion
		allComplete = true
		for (const cell of codeCells) {
			if (cell.document.getText().trim() === "") {
				// bypass cells with empty content, they'll never get a new exec order, or we'll hang waiting here
				continue
			}
			if (cell.executionSummary?.executionOrder === previousExecutionOrders.get(cell.index)) {
				allComplete = false
				break
			}
		}

		if (allComplete) {
			executionComplete = true
			// Give a short delay to ensure outputs are fully populated
			await new Promise((resolve) => setTimeout(resolve, 500))
		} else {
			// Wait a bit before checking again
			await new Promise((resolve) => setTimeout(resolve, 200))
		}
	}

	// Format results similar to getCells
	let result = `# Cell Execution Results\n\n`
	if (!allComplete) {
		Logger.warn('Cell execution did not complete within timeout', { ...context, timeout: timeoutSeconds });
		result += `> Mind that not all cells completed execution within ${timeoutSeconds} seconds!\n`
	} else {
		Logger.operationSuccess('Execute notebook cells', context);
	}
	result += `Executed ${codeCells.length} code cells in range ${startIndex}-${stopIndex - 1}.\n\n`

	for (const cell of codeCells) {
		result += showCell(cell, maxOutputSize)
		result += "---\n\n"
	}

	return result
}

/**
 * Class providing notebook-related operations for the notebook tool
 */
export class NotebookService {
	/**
	 * Gets comprehensive information about the active notebook
	 *
	 * @returns A string containing detailed information about the notebook, including URI, kernel, and cell stats
	 */
	static async getNotebookInfo(): Promise<string> {
		return ErrorUtils.safeExecute(async () => {
			const notebookEditor = vscode.window.activeNotebookEditor
			if (!notebookEditor) { // no active nb is an expected case for this tool function
				return "# Notebook Information\n\nNo active notebook found."
			}

			const notebook = notebookEditor.notebook
			const uri = notebook.uri.toString()

			// Get total cells count
			const totalCells = notebook.cellCount
			const cells = notebook.getCells()

			// Get counts per cell type
			const markdownCellCount = cells.filter((cell) => cell.kind === vscode.NotebookCellKind.Markup).length
			const codeCellCount = cells.filter((cell) => cell.kind === vscode.NotebookCellKind.Code).length

			// Get counts per language
			const languageCounts: Record<string, number> = {}
			for (const cell of cells) {
				if (cell.kind === vscode.NotebookCellKind.Code) {
					const language = cell.document.languageId
					languageCounts[language] = (languageCounts[language] || 0) + 1
				}
			}

			const kernelSpec = notebook.metadata?.metadata?.kernelspec

			// Get execution info - count executed cells
			const executedCellsCount = cells.filter(
				(cell) => cell.kind === vscode.NotebookCellKind.Code && cell.executionSummary !== undefined,
			).length

			// Format the response
			let result = `# Notebook Information\n\n`

			result += `## Basic Information\n`
			result += `- **URI**: ${uri}\n`
			result += `- **Notebook Type**: ${notebook.notebookType}\n`
			result += `- **Dirty?**: ${notebookEditor.notebook.isDirty}\n`
			if (kernelSpec) {
				result += `- **Kernel Language**: ${kernelSpec.language}\n`
				result += `- **Kernel**: ${kernelSpec.display_name} (${kernelSpec.name})\n`
			}
			result += "\n"

			result += `## Cell Statistics\n`
			result += `- **Total Cells**: ${totalCells}\n`
			result += `- **Markdown Cells**: ${markdownCellCount}\n`
			result += `- **Code Cells**: ${codeCellCount}\n`
			result += `- **Executed Code Cells**: ${executedCellsCount}\n\n`

			if (Object.keys(languageCounts).length > 0) {
				result += `## Language Distribution\n`
				for (const [language, count] of Object.entries(languageCounts)) {
					result += `- **${language}**: ${count} cells\n`
				}
			}

			return result
		}, 'getNotebookInfo', { operation: 'getNotebookInfo' });
	}

	/**
	 * Gets information about all cells in the active notebook
	 *
	 * @param maxOutputSize Maximum size for cell content and outputs (default: 2000 characters)
	 * @returns A string containing formatted information about all cells
	 */
	static async getCells(maxOutputSize: number = 2000): Promise<string> {
		return ErrorUtils.safeExecute(async () => {
			const notebookEditor = vscode.window.activeNotebookEditor
			if (!notebookEditor) {
				throw ErrorFactory.noActiveNotebook('getCells');
			}

			const cells = notebookEditor.notebook.getCells()
			if (cells.length === 0) {
				return "# Notebook Analysis\n\nThe notebook is empty - it contains no cells."
			}

			let result = `# Notebook Analysis\n\nNotebook contains ${cells.length} cells:\n\n`

			for (const cell of cells) {
				result += showCell(cell, maxOutputSize)
				result += "---\n\n"
			}

			return result
		}, 'getCells', { operation: 'getCells', maxOutputSize });
	}

	/**
	 * Inserts multiple cells at the specified position
	 *
	 * @param cells Array of cell definitions to insert
	 * @param insertPosition Optional position to insert the cells (defaults to end)
	 * @param noexec Optional flag to skip execution of inserted cells (defaults to false)
	 * @param maxOutputSize Maximum size for cell output (default: 2000 characters)
	 * @param timeoutSeconds Maximum seconds to wait for execution (default: 30)
	 * @returns A string indicating success or failure
	 */
	static async insertCells(
		cells: Array<{
			content: string
			cell_type?: string
			language_id?: string
		}>,
		insertPosition?: number,
		noexec: boolean = false,
		maxOutputSize: number = 2000,
		timeoutSeconds: number = 30,
	): Promise<string> {
		const context: ErrorContext = {
			operation: 'insertCells',
			insertPosition,
			cellCount: cells.length
		};

		return ErrorUtils.safeExecute(async () => {
			const notebookEditor = vscode.window.activeNotebookEditor
			if (!notebookEditor) {
				throw ErrorFactory.noActiveNotebook('insertCells');
			}

			if (cells.length === 0) {
				throw ErrorFactory.validationError('cells array is required and must not be empty', context);
			}

			const position =
				typeof insertPosition === "number"
					? Math.min(Math.max(0, insertPosition), notebookEditor.notebook.cellCount)
					: notebookEditor.notebook.cellCount // Default to end

			// Create cell data for each cell definition
			const cellDataArray: vscode.NotebookCellData[] = cells.map((cellDefinition) => {
				// Determine cell kind based on cell_type
				const cellKind =
					cellDefinition.cell_type === "code" ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup

				// Set language ID based on parameters and cell type
				let cellLanguageId =
					cellKind === vscode.NotebookCellKind.Markup ? "markdown" : cellDefinition.language_id || ""

				// If still no language ID for code cells, try to get from existing cells as fallback
				if (cellKind === vscode.NotebookCellKind.Code && !cellLanguageId && notebookEditor.notebook.cellCount > 0) {
					// Try to get language from existing code cells
					for (const cell of notebookEditor.notebook.getCells()) {
						if (cell.kind === vscode.NotebookCellKind.Code) {
							cellLanguageId = cell.document.languageId
							break
						}
					}

					// Final fallback
					if (!cellLanguageId) {
						cellLanguageId = "python" // Python is the more common default for data notebooks
					}
				}

				return new vscode.NotebookCellData(cellKind, cellDefinition.content, cellLanguageId)
			})

			// Create a notebook edit to insert the cells
			const notebookEdit = vscode.NotebookEdit.insertCells(position, cellDataArray)

			// Apply the edit
			const workspaceEdit = new vscode.WorkspaceEdit()
			workspaceEdit.set(notebookEditor.notebook.uri, [notebookEdit])

			await vscode.workspace.applyEdit(workspaceEdit)

			const result = `Successfully inserted ${cellDataArray.length} new cells at position ${position}.`
			if (noexec) return result

			// Execute the newly inserted cells
			const executionResult = await executeNotebookCells(
				notebookEditor.notebook.getCells(),
				position,
				position + cellDataArray.length,
				maxOutputSize,
				timeoutSeconds,
			)
			return result + `\n\n${executionResult}`
		}, 'insertCells', context);
	}

	/**
	 * Replaces a range of cells in the notebook with new cells
	 *
	 * @param validateIndicesAndCells A callback that receives the cell count and validates indices and cells
	 * @param noexec Optional flag to skip execution of replaced cells (defaults to false)
	 * @param maxOutputSize Maximum size for cell output (default: 2000 characters)
	 * @param timeoutSeconds Maximum seconds to wait for execution (default: 30)
	 * @returns A string indicating success or failure
	 */
	static async replaceCells(
		validateIndicesAndCells: (cellCount: number) => {
			startIndex: number
			stopIndex: number
			cells: Array<{
				content: string
				cell_type?: string
				language_id?: string
			}>
		},
		noexec: boolean = false,
		maxOutputSize: number = 2000,
		timeoutSeconds: number = 30,
	): Promise<string> {
		return ErrorUtils.safeExecute(async () => {
			const notebookEditor = vscode.window.activeNotebookEditor
			if (!notebookEditor) {
				throw ErrorFactory.noActiveNotebook('replaceCells');
			}

			const existingCells = notebookEditor.notebook.getCells()

			// Let the callback validate indices and cells based on cell count
			const { startIndex, stopIndex, cells } = validateIndicesAndCells(existingCells.length)

			const context: ErrorContext = {
				operation: 'replaceCells',
				startIndex,
				stopIndex,
				cellCount: existingCells.length
			};

			const cellsToReplace = existingCells.slice(startIndex, stopIndex)
			const cellDataArray: vscode.NotebookCellData[] = cells.map((cellDefinition, iCell) => {
				// Determine cell kind based on cell_type or from existing cell if not specified
				let cellKind: vscode.NotebookCellKind

				if (cellDefinition.cell_type) {
					cellKind =
						cellDefinition.cell_type === "code" ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup
				} else {
					// Use the kind of the corresponding cell, or first cell being replaced
					cellKind = cellsToReplace[iCell < cellsToReplace.length ? iCell : 0].kind
				}

				// Determine language ID based on params, or use existing if not provided
				let languageId: string
				if (cellKind === vscode.NotebookCellKind.Markup) {
					if (cellDefinition.language_id !== undefined && cellDefinition.language_id !== "markdown") {
						throw ErrorFactory.validationError("language_id must be 'markdown' for markdown cells", context);
					}
					languageId = "markdown"
				} else if (cellDefinition.language_id) {
					languageId = cellDefinition.language_id
				} else if (iCell < cellsToReplace.length && cellsToReplace[iCell].kind === vscode.NotebookCellKind.Code) {
					languageId = cellsToReplace[iCell].document.languageId
				} else {
					const firstCodeCell = cellsToReplace.find((cell) => cell.kind === vscode.NotebookCellKind.Code)
					languageId = firstCodeCell?.document.languageId || "python" // Default to python if no language found
				}

				// Create cell data with content and properties
				const cellData = new vscode.NotebookCellData(cellKind, cellDefinition.content, languageId)

				// Try to preserve metadata from the corresponding cell, leave execution summary cleared
				if (iCell < cellsToReplace.length) {
					const peerCell = cellsToReplace[iCell]
					if (peerCell.kind === cellData.kind) {
						cellData.metadata = peerCell.metadata
					}
				}

				return cellData
			})

			// Create notebook edit to replace the range with new cells
			const notebookEdit = vscode.NotebookEdit.replaceCells(
				new vscode.NotebookRange(startIndex, stopIndex),
				cellDataArray,
			)

			// Apply the edit
			const workspaceEdit = new vscode.WorkspaceEdit()
			workspaceEdit.set(notebookEditor.notebook.uri, [notebookEdit])

			await vscode.workspace.applyEdit(workspaceEdit)

			const result = `Successfully replaced ${stopIndex - startIndex} cells with ${cellDataArray.length} new cells.`
			if (noexec) return result

			const executionResult = await executeNotebookCells(
				notebookEditor.notebook.getCells(),
				startIndex,
				startIndex + cellDataArray.length,
				maxOutputSize,
				timeoutSeconds,
			)
			return result + `\n\n${executionResult}`
		}, 'replaceCells', { operation: 'replaceCells' });
	}

	/**
	 * Modify the content of an existing cell
	 *
	 * @param validateCellIndex A callback that receives the cell count and validates/returns the cellIndex
	 * @param content The new content for the cell
	 * @param noexec Optional flag to skip execution of the modified cell (defaults to false)
	 * @param maxOutputSize Maximum size for cell output (default: 2000 characters)
	 * @param timeoutSeconds Maximum seconds to wait for execution (default: 30)
	 * @returns A string indicating success or failure
	 */
	static async modifyCellContent(
		validateCellIndex: (cellCount: number) => number,
		content: string,
		noexec: boolean = false,
		maxOutputSize: number = 2000,
		timeoutSeconds: number = 30,
	): Promise<string> {
		return ErrorUtils.safeExecute(async () => {
			const notebookEditor = vscode.window.activeNotebookEditor
			if (!notebookEditor) {
				throw ErrorFactory.noActiveNotebook('modifyCellContent');
			}

			let cellIndex = 0

			await NotebookService.replaceCells(
				(cellCount: number) => {
					cellIndex = validateCellIndex(cellCount)
					return {
						startIndex: cellIndex,
						stopIndex: cellIndex + 1,
						cells: [{ content }],
					}
				},
				true,
				maxOutputSize,
				timeoutSeconds,
			)

			const result = `Successfully modified cell at index ${cellIndex} with new content.`
			if (noexec) return result

			const executionResult = await executeNotebookCells(
				notebookEditor.notebook.getCells(),
				cellIndex,
				cellIndex + 1,
				maxOutputSize,
				timeoutSeconds,
			)
			return result + `\n\n${executionResult}`
		}, 'modifyCellContent', { operation: 'modifyCellContent' });
	}

	/**
	 * Executes the specified cells in the active notebook and returns their results
	 *
	 * @param validateIndices A callback that receives the total cell count and validates/returns the start and end indices
	 * @param maxOutputSize Maximum size for cell output (default: 2000 characters)
	 * @param timeoutSeconds Maximum seconds to wait for execution (default: 30)
	 * @returns A string containing formatted information about the executed cells
	 */
	static async executeCells(
		validateIndices: (cellCount: number) => { startIndex: number; stopIndex: number },
		maxOutputSize: number = 2000,
		timeoutSeconds: number = 30,
	): Promise<string> {
		return ErrorUtils.safeExecute(async () => {
			const notebookEditor = vscode.window.activeNotebookEditor
			if (!notebookEditor) {
				throw ErrorFactory.noActiveNotebook('executeCells');
			}

			const cells = notebookEditor.notebook.getCells()

			// Let the callback validate and return the indices based on cell count
			const { startIndex, stopIndex } = validateIndices(cells.length)

			// Execute the cells and get the results
			const result = await executeNotebookCells(cells, startIndex, stopIndex, maxOutputSize, timeoutSeconds)

			return result
		}, 'executeCells', { operation: 'executeCells' });
	}

	/**
	 * Deletes a range of cells from the notebook
	 *
	 * @param validateIndices A callback that receives the cell count and validates indices
	 * @returns A string indicating success or failure
	 */
	static async deleteCells(
		validateIndices: (cellCount: number) => { startIndex: number; stopIndex: number },
	): Promise<string> {
		return ErrorUtils.safeExecute(async () => {
			const notebookEditor = vscode.window.activeNotebookEditor
			if (!notebookEditor) {
				throw ErrorFactory.noActiveNotebook('deleteCells');
			}

			const existingCells = notebookEditor.notebook.getCells()

			// Let the callback validate indices based on cell count
			const { startIndex, stopIndex } = validateIndices(existingCells.length)

			// Calculate how many cells will be deleted
			const deleteCount = stopIndex - startIndex

			// Create notebook edit to delete the range of cells
			const notebookEdit = vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(startIndex, stopIndex))

			// Apply the edit
			const workspaceEdit = new vscode.WorkspaceEdit()
			workspaceEdit.set(notebookEditor.notebook.uri, [notebookEdit])

			await vscode.workspace.applyEdit(workspaceEdit)

			return `Successfully deleted ${deleteCount} cell${deleteCount !== 1 ? "s" : ""} from index ${startIndex} to ${stopIndex - 1}.`
		}, 'deleteCells', { operation: 'deleteCells' });
	}

	/**
	 * Saves the active notebook to disk
	 * 
	 * @returns A string indicating success or failure
	 */
	static async saveNotebook(): Promise<string> {
		return ErrorUtils.safeExecute(async () => {
			const notebookEditor = vscode.window.activeNotebookEditor
			if (!notebookEditor) {
				throw ErrorFactory.noActiveNotebook('saveNotebook');
			}

			// Save the notebook using the workspace API
			await vscode.workspace.save(notebookEditor.notebook.uri)

			return `Successfully saved notebook: ${notebookEditor.notebook.uri.toString()}`
		}, 'saveNotebook', {
			operation: 'saveNotebook'
		});
	}

	/**
	 * Restarts the kernel for the active notebook
	 * 
	 * @returns A string indicating success or failure
	 */
	static async restartKernel(): Promise<string> {
		return ErrorUtils.safeExecute(async () => {
			const notebookEditor = vscode.window.activeNotebookEditor
			if (!notebookEditor) {
				throw ErrorFactory.noActiveNotebook('restartKernel');
			}

			// Execute the restart kernel command
			await vscode.commands.executeCommand('jupyter.restartkernel')

			return `Successfully restarted kernel for notebook: ${notebookEditor.notebook.uri.toString()}`
		}, 'restartKernel', {
			operation: 'restartKernel'
		});
	}

	/**
	 * Interrupts the kernel execution for the active notebook
	 * 
	 * @returns A string indicating success or failure
	 */
	static async interruptKernel(): Promise<string> {
		return ErrorUtils.safeExecute(async () => {
			const notebookEditor = vscode.window.activeNotebookEditor
			if (!notebookEditor) {
				throw ErrorFactory.noActiveNotebook('interruptKernel');
			}

			// Execute the interrupt kernel command
			await vscode.commands.executeCommand('jupyter.interruptkernel')

			return `Successfully interrupted kernel execution for notebook: ${notebookEditor.notebook.uri.toString()}`
		}, 'interruptKernel', {
			operation: 'interruptKernel'
		});
	}
}

// Backward compatibility - export the old NotebookError as an alias to RooNotebookError
export const NotebookError = RooNotebookError;
