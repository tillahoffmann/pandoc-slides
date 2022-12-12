const vscode = acquireVsCodeApi();

function maybeReplaceRelativePath(element, attribute) {
    const documentWebviewUri = document.querySelector("meta[name='document-webview-uri']").content;
    let path = element.getAttribute(attribute);
    try {
        // If this succeeds, we already have an absolute url.
        new URL(path);
        return 0;
    } catch (error) {
        path = new URL(path, documentWebviewUri);
        element.setAttribute(attribute, path.toString());
        return 1;
    }
}

// eslint-disable-next-line @typescript-eslint/naming-convention
let PandocSlides = {
    id: "pandoc-slides",
    init: deck => {
        console.log("initializing ...", deck);

        // We replace all data-src references if they are not absolute.
        document.querySelectorAll("[data-src]").forEach(element => maybeReplaceRelativePath(element, "data-src"));
        // Same for style sheets.
        document.querySelectorAll("link[rel='stylesheet']").forEach(element => maybeReplaceRelativePath(element, "href"));

        // Monitor reveal.js events and forward them to VS Code (https://revealjs.com/events/).
        deck.on("slidechanged", event => {
            vscode.postMessage({
                type: event.type,
                indexh: event.indexh,
                indexv: event.indexv,
            });
        });

        // Walk over all slides and send the markdown code positions back to vscode.
        deck.getSlides().forEach(slide => {
            const sourcepos = slide.getAttribute("data-pos");
            if (!sourcepos) {
                return;
            }
            const indices = deck.getIndices(slide);
            vscode.postMessage({
                type: "sourcepos",
                indexh: indices.h,
                indexv: indices.v,
                sourcepos: sourcepos,
            });
        });
    }
};


// Receive messages from VS Code and forward them to the reveal.js API (https://revealjs.com/api/).
window.addEventListener('message', event => {
    Reveal[event.data.method](...event.data.args);
});


// Jump to the markdown section in the editor.
window.addEventListener("dblclick", event => {
    const dataPos = event.target.getAttribute("data-pos");
    vscode.postMessage({
        type: "sourcepos-navigate",
        value: dataPos,
    });
});
