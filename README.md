---
pandoc:
    highlight-style: null
---

# 📽️ pandoc-slides

## Create stunning presentations in markdown

This exension compiles [markdown](https://commonmark.org) to beautiful [reveal.js](https://revealjs.com) slides using [pandoc](https://pandoc.org).

## Features

- ✨ interactive preview of your presentation.
- 🧭 navigate from slides to markdown and vice versa.
- 💾 compile your presentation automatically on save.
- ⚙️ [flexible declarative configuration](#declarative-configuration) to ensure your slides look just the way you want. Every time.
- 📽️ export your presentation to HTML, including speaker notes.

## Declarative configuration

You can configure pandoc with `yaml` frontmatter using it's [defaults file](https://pandoc.org/MANUAL.html#defaults-files) syntax.
```yaml
pandoc:
  # Render equations using katex.
  html-math-method:
    method: katex
  variables:
    theme: white
```
We'll provide sensible defaults to get you started. Find out more about configuring your slides [here](https://pandoc.org/MANUAL.html#styling-the-slides).

## Requirements

[pandoc](https://pandoc.org/installing.html) needs to be installed.

## Extension Settings

This extension contributes the following settings:

- `pandocSlides.compileOnSave`: Compile slides on save when they are shown in the preview pane.
- `pandocSlides.showNavigationCodeLenses`: Show code lenses for jumping from markdown to the corresponding slide.

## Down the rabbit hole ...

This is a presentation. Install the extension, copy the markdown, and hit the preview button.
