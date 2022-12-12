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
import { setFlagsFromString } from 'v8';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// Create a slide preview instance and register all functionality on that instance. This means
	// we don't need to manage singletons.
	const slidePreviewPanel = new SlidePreviewPanel(context);
	context.subscriptions.push(
		vscode.commands.registerCommand("pandoc-slides.sidePreview", slidePreviewPanel.showPreview.bind(slidePreviewPanel)),
		vscode.commands.registerCommand("pandoc-slides.jumpToSlide", slidePreviewPanel.jumpToSlide.bind(slidePreviewPanel)),
		vscode.languages.registerCodeLensProvider({
			scheme: "file",
			language: "markdown",
		}, slidePreviewPanel.codeLensProvider),
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

	public navigate(indexh: number, indexv: number) {
		this._panel!.webview.postMessage({
			"method": "slide",
			"args": [indexh, indexv],
		});
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
			if(this._pairedEditor) {
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

	public async showPreview() {
		// Abort if there is no active editor.
		if (!vscode.window.activeTextEditor) {
			return;
		}

		// Reset any state if the uri of the file to be previewed has changed and pair the editor.
		if (this._pairedEditor && this._pairedEditor.document.uri !== vscode.window.activeTextEditor.document.uri) {
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
			});
			this._panel.webview.onDidReceiveMessage(this._handleWebviewMessage.bind(this));
		} else {
			this._panel.title = title;
		}

		this._panel.webview.html = await this._getHtmlContent();
		this._panel.reveal();

		// Post a message to navigate back to the slide we were on.
		this._panel.webview.postMessage({
			"method": "slide",
			"args": [this._indexh, this._indexv],
		});
	}

	private async _getHtmlContent() {
		// Load the frontmatter and set defaults. We'll be loading the active file and writing to
		// stdout.
		const document = this._pairedEditor!.document;
		let frontmatter = yamlfrontmatter.loadFront(document.getText());
		let pandoc = frontmatter.pandoc ?? {};
		pandoc["input-file"] = document.fileName;
		pandoc["output-file"] = "-";
		pandoc["to"] ??= "revealjs";
		pandoc["from"] ??= "commonmark_x+sourcepos";

		// Build the includes for the header.
		pandoc.variables ??= {};
		pandoc.variables["header-includes"] ??= [];
		// Push the webview uri (which requires a trailing slash).
		const documentUri = vscode.Uri.file(path.dirname(document.fileName));
		pandoc.variables["header-includes"].push(`<meta name="document-webview-uri" content="${this._panel!.webview.asWebviewUri(documentUri)}/">`);
		// Push the plugin code.
		const pluginUri = vscode.Uri.joinPath(this._context.extensionUri, "assets", "plugin.js");
		pandoc.variables["header-includes"].push(`<script src="${this._panel!.webview.asWebviewUri(pluginUri)}"></script>`);
		// Push a random value so the webview content is reloaded.
		pandoc.variables["header-includes"].push(`<meta name="webview-uuid" content="${uuid.v4()}">`);

		// Create a temporary file ...
		let html = tmp.withFile(async (tmpfile) => {
			// ... and dump the pandoc config (https://pandoc.org/MANUAL.html#defaults-files).
			await fs.promises.writeFile(tmpfile.path, JSON.stringify(pandoc));
			// Generate the html.
			try {
				let {stdout, stderr} = await promisify(child_process.execFile)("pandoc", [
					"--standalone", "-d", tmpfile.path
				]);
				// We need to hack the plugin until https://github.com/jgm/pandoc/issues/6401 is resolved.
				stdout = stdout.replace(
					/reveal\.js plugins\n\s*plugins: \[/,
					`reveal.js plugins\nplugins: [ PandocSlides,`,
				);
				return stdout;
			} catch (error: any) {
				vscode.window.showErrorMessage(`Failed to compile slides: ${error.stderr}.`);
				const errorUri = vscode.Uri.joinPath(this._context.extensionUri, "assets",
					vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ?
					"error-light.svg" : "error-dark.svg");
				return `
				<h1><img src="${this._panel!.webview.asWebviewUri(errorUri)}"> Failed to compile slides.</h1>
				<pre style="white-space: pre-wrap;">${error}</pre>
				`;
			}
		}, {postfix: ".yaml"});
		return html;
	}
}
