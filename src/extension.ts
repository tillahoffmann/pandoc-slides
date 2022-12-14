// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as yamlfrontmatter from 'yaml-front-matter';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import * as tmp from 'tmp-promise';
import * as uuid from 'uuid';
import { promisify } from 'util';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// Create a slide preview instance and register all functionality on that instance. This means
	// we don't need to manage singletons.
	const slidePreviewPanel = new SlidePreviewPanel(context);
	context.subscriptions.push(
		vscode.commands.registerCommand("pandoc-slides.sidePreview", slidePreviewPanel.showPreview, slidePreviewPanel),
		vscode.commands.registerCommand("pandoc-slides.jumpToSlide", slidePreviewPanel.jumpToSlide, slidePreviewPanel),
		vscode.languages.registerCodeLensProvider({
			scheme: "file",
			language: "markdown",
		}, slidePreviewPanel.codeLensProvider),
		vscode.workspace.onDidSaveTextDocument(slidePreviewPanel.onDidSaveTextDocument, slidePreviewPanel),
		vscode.workspace.onDidChangeTextDocument(slidePreviewPanel.onDidChangeTextDocument, slidePreviewPanel),
		vscode.commands.registerCommand("pandoc-slides.exportSlides", slidePreviewPanel.export, slidePreviewPanel),
	);
}

// This method is called when your extension is deactivated
export function deactivate() { }


class CodeLensProvider implements vscode.CodeLensProvider {
	private readonly _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;
	private _documentUri: vscode.Uri | undefined;
	private _records: Array<any> | undefined;

	public updateCodeLenses(documentUri: vscode.Uri, records: Array<any>) {
		this._documentUri = documentUri;
		this._records = records;
		this._onDidChangeCodeLenses.fire();
	}

	public resetCodeLenses() {
		this._documentUri = undefined;
		this._records = undefined;
		this._onDidChangeCodeLenses.fire();
	}

	provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
		// Skip if this is the wrong document.
		if (document.uri !== this._documentUri) {
			return [];
		}
		return this._records!.map((record: any) => {
			return new vscode.CodeLens(parseRange(record.sourcepos), {
				"title": "Jump to slide",
				"command": "pandoc-slides.jumpToSlide",
				"arguments": [record],
			});
		});
	}

	resolveCodeLens?(codeLens: vscode.CodeLens, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens> {
		return codeLens;
	}
}

function parseRange(value: any) {
	const [startLine, startChar, endLine, endChar]: [number, number, number, number] =
		value.split("@").pop().split(/[:-]/).map((x: string) => parseInt(x));
	return new vscode.Range(startLine - 1, startChar - 1, endLine - 1, endChar - 1);
}

function setAttributeIfUndefined(x: any, key: string, value: any) {
	if(x[key] === undefined) {
		x[key] = value;
		return value;
	}
	return x[key];
}

/**
 * Singleton preview panel for slides.
 */
class SlidePreviewPanel {
	private readonly _context: vscode.ExtensionContext;
	public readonly codeLensProvider: CodeLensProvider;
	private _panel: vscode.WebviewPanel | undefined;
	private _indexh: number = 0;
	private _indexv: number = 0;
	private _pairedEditor: vscode.TextEditor | undefined;

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
		this.codeLensProvider = new CodeLensProvider();
	}

	public onDidSaveTextDocument(document: vscode.TextDocument) {
		// Compile the document on save.
		if(vscode.workspace.getConfiguration("pandocSlides").get("compileOnSave")
		   && this._pairedEditor && this._pairedEditor.document.uri === document.uri) {
			this.showPreview(false);
		}
	}

	public onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent) {
		// Remove code lenses if lines were inserted or deleted.
		if (this._pairedEditor && this._pairedEditor.document.uri === event.document.uri) {
			for (let change of event.contentChanges) {
				console.log("line delta", change.range.start.line - change.range.end.line + change.text.split("\n").length - 1);
				if (!change.range.isSingleLine || change.text.includes("\n")) {
					this.codeLensProvider.resetCodeLenses();
					return;
				}
			}
		}
	}

	private _handleWebviewMessage(message: any) {
		// Handle the `slidechanged` event and store the indices so we can jump straight back to the
		// original slide when the preview is refreshed.
		if (message.type === "slidechanged") {
			this._indexh = message.indexh;
			this._indexv = message.indexv;
		// Handle a navigation event initiated by the slide view so we can look up the corresponding
		// source.
		} else if (message.type === "sourcepos-navigate") {
			if (this._pairedEditor) {
				const range = parseRange(message.value);
				this._pairedEditor.selection = new vscode.Selection(range.start, range.end);
				this._pairedEditor.revealRange(range);
			}
		// Handle information provided by the slide view so we can navigate from source to the
		// corresponding slide.
		} else if (message.type === "sourcepos") {
			if(vscode.workspace.getConfiguration("pandocSlides").get("showNavigationCodeLenses") && this._pairedEditor) {
				this.codeLensProvider.updateCodeLenses(this._pairedEditor.document.uri, message.records);
			}
		// Log any messages we don't know about for debugging.
		} else {
			console.log(`received unexpected message ${JSON.stringify(message)}`);
		}
	}

	public async jumpToSlide(record: any) {
		// Post a message to navigate back to the slide we were on.
		if (this._panel) {
			this._panel.webview.postMessage({
				"method": "slide",
				"args": [record.indexh, record.indexv],
			});
		}
	}

	public async showPreview(reveal: boolean) {
		// Abort if there is no active editor.
		if (!vscode.window.activeTextEditor) {
			return;
		}

		// Reset any state if the uri of the file to be previewed has changed and pair the editor.
		if (this._pairedEditor !== vscode.window.activeTextEditor) {
			this._indexh = this._indexv = 0;
		}
		this._pairedEditor = vscode.window.activeTextEditor;

		// Create the preview panel if it does not exist.
		const title = `Preview ${path.basename(this._pairedEditor.document.fileName)}`;
		if (!this._panel) {
			this._panel = vscode.window.createWebviewPanel(
				"slidePreview", title, vscode.ViewColumn.Two, {
					enableScripts: true,
					retainContextWhenHidden: true,
			});
			this._panel.iconPath = {
				light: vscode.Uri.joinPath(this._context.extensionUri, "assets", "versions-light.svg"),
				dark: vscode.Uri.joinPath(this._context.extensionUri, "assets", "versions-dark.svg"),
			};
			this._panel.onDidDispose(() => {
				this._panel = undefined;
				this._pairedEditor = undefined;
				this.codeLensProvider.resetCodeLenses();
			});
			this._panel.webview.onDidReceiveMessage(this._handleWebviewMessage.bind(this));
		} else {
			this._panel.title = title;
		}

		this._panel.webview.html = await this._runPandoc(this._pairedEditor.document);
		if (reveal) {
			this._panel.reveal();
		}
	}

	public async export() {
		// Abort if there is no active editor.
		if (!vscode.window.activeTextEditor) {
			return;
		}
		const document = vscode.window.activeTextEditor.document;
		let fileName = path.parse(document.uri.fsPath);
		fileName.ext = ".html";
		fileName.base = "";
		this._runPandoc(document, path.format(fileName));
	}

	private async _runPandoc(document: vscode.TextDocument, fileName?: string) {
		// Load the frontmatter and set defaults. We'll be loading the active file and writing to
		// stdout.
		let frontmatter = yamlfrontmatter.loadFront(document.getText());
		let pandoc = frontmatter.pandoc ?? {};
		pandoc["input-file"] = document.fileName;
		pandoc["output-file"] = fileName ?? "-";
		pandoc["to"] ??= "revealjs";
		pandoc["from"] ??= "commonmark_x+sourcepos";
		pandoc["template"] ??= vscode.Uri.joinPath(this._context.extensionUri, "assets", "default.revealjs").toString();

		let variables = setAttributeIfUndefined(pandoc, "variables", {});
		// By default, let's use highlightjs for code ...
		if(setAttributeIfUndefined(variables, "highlightjs", true)) {
			// ... and disable the built-in highlighter.
			setAttributeIfUndefined(pandoc, "highlight-style", null);
		}

		// We only need these modifications in the interactive mode.
		if(!fileName) {
			// Construct a path for the parent directory of this document so we can load local content.
			const parentUri = vscode.Uri.file(path.dirname(document.fileName));
			// Build the includes for the header.
			setAttributeIfUndefined(variables, "header-includes", []).push([
				`<meta name="parent-webview-uri" content="${this._panel!.webview.asWebviewUri(parentUri)}/">`,
				// Random value to reload the webview every time.
				`<meta name="webview-uuid" content="${uuid.v4()}">`,
				// Slide indices for navigating to the most recently viewed frame after compilation.
				`<meta name="slide-indices" content="${this._indexh},${this._indexv}">`,
			]);
			// Construct a path to the plugin code we need to interface with vscode.
			const pluginUri = vscode.Uri.joinPath(this._context.extensionUri, "assets", "plugin.js");
			variables["pandoc-slides-plugin-url"] = this._panel!.webview.asWebviewUri(pluginUri).toString();
		}

		// Create a temporary file ...
		let html = tmp.withFile(async (tmpfile) => {
			// ... and dump the pandoc config (https://pandoc.org/MANUAL.html#defaults-files).
			await fs.promises.writeFile(tmpfile.path, JSON.stringify(pandoc));
			// Generate the html.
			try {
				let {stdout, stderr} = await promisify(child_process.execFile)("pandoc", [
					"--standalone", "-d", tmpfile.path
				]);
				return stdout;
			} catch (error: any) {
				vscode.window.showErrorMessage(`Failed to compile slides: ${error.stderr}.`);
				if (fileName) {
					return error;
				} else {
					const errorUri = vscode.Uri.joinPath(this._context.extensionUri, "assets",
						vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ?
						"error-light.svg" : "error-dark.svg");
					return `
					<h1><img src="${this._panel!.webview.asWebviewUri(errorUri)}"> Failed to compile slides.</h1>
					<pre style="white-space: pre-wrap;">${error}</pre>
					`;
				}
			}
		}, {postfix: ".yaml"});
		return html;
	}
}
