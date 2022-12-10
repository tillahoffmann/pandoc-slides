const vscode = acquireVsCodeApi();

// eslint-disable-next-line @typescript-eslint/naming-convention
let PandocSlides = {
    id: "pandoc-slides",
    init: deck => {
        console.log("initializing ...", deck);

        // We replace all data-src references if they are not absolute.
        const documentWebviewUri = document.querySelector("meta[name='document-webview-uri']").content;
        console.log(`identified document webview uri: ${documentWebviewUri}`);
        let replaced = 0;
        for (let element of document.querySelectorAll("[data-src]")) {
            let dataSrc = element.getAttribute("data-src");
            try {
                // If this succeeds, we already have an absolute url.
                new URL(dataSrc);
            } catch (error) {
                dataSrc = new URL(dataSrc, documentWebviewUri);
                element.setAttribute("data-src", dataSrc.toString());
                replaced += 1;
            }
        }
        console.log(`replaced ${replaced} relative 'data-src' attributes`);

        // Monitor reveal.js events and forward them to VS Code (https://revealjs.com/events/).
        deck.on("slidechanged", event => {
            vscode.postMessage({
                type: event.type,
                indexh: event.indexh,
                indexv: event.indexv,
            });
        });
    }
};


// Receive messages from VS Code and forward them to the reveal.js API (https://revealjs.com/api/).
window.addEventListener('message', event => {
    console.log(event);
    Reveal[event.data.method](...event.data.args);
});
