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
	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('pandoc-slides.sidePreview', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		showSidePreview(context);
	});
	context.subscriptions.push(disposable);

	// Set up the code lens for navigating to slides.
	disposable = vscode.languages.registerCodeLensProvider({ scheme: "file", language: "markdown"},
											  			   new CodeLensProvider());
	context.subscriptions.push(disposable);

	// Add the command for jumping.
	disposable = vscode.commands.registerCommand("pandoc-slides.jumpToSlide", (sourcepos) => {
		jumpToSlide(context, sourcepos);
	});
	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() { }

class CodeLensProvider implements vscode.CodeLensProvider {
	onDidChangeCodeLenses?: vscode.Event<void> | undefined;
	provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
		// Skip if there's no paired editor or the editor is for a different file.
		let editor = SlidePreviewPanel.getInstance().pairedEditor;
		if (!editor || editor.document.uri !== document.uri) {
			return [];
		}
		return SlidePreviewPanel.getInstance().sourceposLookup.map((message: any) => {
			return new vscode.CodeLens(parseRange(message.sourcepos), {
				title: "Jump to slide",
				command: "pandoc-slides.jumpToSlide",
				arguments: [message],
			});
		});
	}

	resolveCodeLens?(codeLens: vscode.CodeLens, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens> {
		throw new Error('Method not implemented.');
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
	private static _instance: SlidePreviewPanel | undefined;
	private _panel: vscode.WebviewPanel | undefined;
	private _indexh: number = 0;
	private _indexv: number = 0;
	public pairedEditor: vscode.TextEditor | undefined;
	public sourceposLookup: Array<any> = [];

	/**
	 * Get the singleton instance.
	 */
	public static getInstance() {
		if (!SlidePreviewPanel._instance) {
			SlidePreviewPanel._instance = new SlidePreviewPanel();
		}
		return SlidePreviewPanel._instance;
	}

	public navigate(indexh: number, indexv: number) {
		this._panel!.webview.postMessage({
			"method": "slide",
			"args": [indexh, indexv],
		});
	}

	private constructor() {}

	private _handleWebviewMessage(message: any) {
		// Handle the `slidechanged` event and store the indices so we can jump straight back to the
		// original slide when the preview is refreshed.
		if (message.type === "slidechanged") {
			this._indexh = message.indexh;
			this._indexv = message.indexv;
		} else if (message.type === "sourcepos-navigate") {
			const range = parseRange(message.value);
			this.pairedEditor!.selection = new vscode.Selection(range.start, range.end);
			this.pairedEditor?.revealRange(range);
		} else if (message.type === "sourcepos") {
			this.sourceposLookup.push(message);
		} else {
			console.log(`received unexpected message ${JSON.stringify(message)}`);
		}
	}

	public async showPreview(context: vscode.ExtensionContext) {
		// Reset any state if the uri of the file to be previewed has changed.
		if (this.pairedEditor && this.pairedEditor!.document.uri !== vscode.window.activeTextEditor!.document.uri) {
			this._indexh = this._indexv = 0;
		}
		// Store the paired editor, update the title, html, and show the document.
		this.pairedEditor = vscode.window.activeTextEditor;
		// Create the preview panel if it does not exist and destroy it when the webview is disposed
		// off, e.g., by the user closing the panel.
		const title = `Preview ${path.basename(this.pairedEditor!.document.fileName)}`;
		if (!this._panel) {
			this._panel = vscode.window.createWebviewPanel(
				"slidePreview", title, vscode.ViewColumn.Two, {
					enableScripts: true,
					retainContextWhenHidden: true,
			});
			this._panel.iconPath = {
				light: vscode.Uri.joinPath(context.extensionUri, "assets", "versions-light.svg"),
				dark: vscode.Uri.joinPath(context.extensionUri, "assets", "versions-dark.svg"),
			};
			this._panel.onDidDispose(() => {
				SlidePreviewPanel._instance = undefined;
			});
			this._panel.webview.onDidReceiveMessage(this._handleWebviewMessage.bind(this));
		} else {
			this._panel.title = title;
		}

		this._panel.webview.html = await this._getHtmlContent(context);
		this._panel.reveal();

		// Post a message to navigate back to the slide we were on.
		this._panel.webview.postMessage({
			"method": "slide",
			"args": [this._indexh, this._indexv],
		});
	}

	private async _getHtmlContent(context: vscode.ExtensionContext) {
		// Load the frontmatter and set defaults. We'll be loading the active file and writing to
		// stdout.
		const document = this.pairedEditor!.document;
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
		const pluginUri = vscode.Uri.joinPath(context.extensionUri, "assets", "plugin.js");
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
				const errorUri = vscode.Uri.joinPath(context.extensionUri, "assets",
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

async function showSidePreview(context: vscode.ExtensionContext) {
	await SlidePreviewPanel.getInstance().showPreview(context);
}

async function jumpToSlide(context: vscode.ExtensionContext, sourcepos: any) {
	SlidePreviewPanel.getInstance().navigate(sourcepos.indexh, sourcepos.indexv);
}
