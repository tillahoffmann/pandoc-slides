// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as yamlfrontmatter from 'yaml-front-matter';
import * as path from 'path';
import { writeFileSync } from 'fs';
import { exec } from 'child_process';
import { fileSync } from 'tmp';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "pandoc-slides" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('pandoc-slides.sidePreview', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		showSidePreview(context);
	});
	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() { }

/**
 * Singleton preview panel for slides.
 */
class SlidePreviewPanel {
	private static _instance: SlidePreviewPanel | undefined;
	private readonly _panel: vscode.WebviewPanel;
	private _fileName: string | undefined;
	private _indexh: number;
	private _indexv: number;
	private _context: vscode.ExtensionContext;

	/**
	 * Get the singleton instance and instantiate the webview.
	 */
	public static getInstance(context: vscode.ExtensionContext) {
		if (!SlidePreviewPanel._instance) {
			const panel = vscode.window.createWebviewPanel("slidePreview", "Preview ...", 2, {
				enableScripts: true,
				retainContextWhenHidden: true,
			});
			SlidePreviewPanel._instance = new SlidePreviewPanel(panel, context);
		}
		return SlidePreviewPanel._instance;
	}

	private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
		this._context = context;
		this._panel = panel;
		this._indexh = this._indexv = 0;
		this._panel.webview.onDidReceiveMessage(message => {
			// Handle the `slidechanged` event and store the indices so we can jump straight back to
			// the original slide when the preview is refreshed.
			if (message.type === "slidechanged") {
				this._indexh = message.indexh;
				this._indexv = message.indexv;
			}
		});
	}

	public update() {
		const document = vscode.window.activeTextEditor!.document;
		// Update the status of the webview.
		this._panel.title = `Preview ${document.fileName.split(/[\\/]/).pop()}`;

		// Load the frontmatter and set defaults. We'll be loading the active file and writing to
		// stdout.
		let frontmatter = yamlfrontmatter.loadFront(document.getText());
		let pandoc = frontmatter.pandoc ?? {};
		pandoc["input-file"] = document.fileName;
		pandoc["output-file"] = "-";

		// Build the includes for the header.
		pandoc.variables ??= {};
		pandoc.variables["header-includes"] ??= [];

		// Push the webview uri (which requires a trailing slash).
		const documentUri = vscode.Uri.file(path.dirname(document.fileName));
		pandoc.variables["header-includes"].push(`<meta name="document-webview-uri" content="${this._panel.webview.asWebviewUri(documentUri)}/">`);
		// Push the plugin code.
		const pluginUri = vscode.Uri.joinPath(this._context.extensionUri, "assets", "plugin.js");
		pandoc.variables["header-includes"].push(`<script src="${this._panel.webview.asWebviewUri(pluginUri)}"></script>`);


		// Write the content to a temporary file and call pandoc.
		const tmpfile = fileSync({
			postfix: ".yaml"
		});
		writeFileSync(tmpfile.fd, JSON.stringify(pandoc));
		exec(
			`pandoc --standalone -d ${tmpfile.name}`, { cwd: path.dirname(document.fileName) },
			(error, stdout, stderr) => {
				if (error) {
					this._panel.webview.html = `<pre style="white-space: pre-wrap;">${stderr}</pre>`;
				} else {
					// We need to hack the plugin until https://github.com/jgm/pandoc/issues/6401 is resolved.
					stdout = stdout.replace(
						/reveal\.js plugins\n\s*plugins: \[/,
						`reveal.js plugins\nplugins: [ PandocSlides,`,
					);
					this._panel.webview.html = stdout;

					// Execute a navigation event to get back to the previous slide.
					if (document.fileName === this._fileName) {
						this._panel.webview.postMessage({
							"method": "slide",
							"args": [this._indexh, this._indexv],
						});
					}
					this._fileName = document.fileName;
				}
				tmpfile.removeCallback();
			});
	}
}

async function showSidePreview(context: vscode.ExtensionContext) {
	SlidePreviewPanel.getInstance(context).update();
}
