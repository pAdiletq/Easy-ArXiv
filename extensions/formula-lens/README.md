# Easy ArXiv — Formula Lens · 0.1.0

A small Chrome side panel for exploring the attention equation beside the **ordinary, built-in Chrome PDF viewer**. It does not replace the PDF viewer, intercept PDF downloads, edit the file, redirect the tab, or change the original arXiv address.

## How to use

1. Open `https://arxiv.org/pdf/1706.03762` normally in Chrome.
2. On page 4, select the whole printed equation (1), including `Attention(Q,K,V)`, `softmax`, the fraction and final `V`.
3. Right-click the selection and choose **Разобрать формулу · Easy ArXiv**.
4. Chrome opens a side panel next to the original PDF. Change Q, or choose a token and change its K or V coordinates. Weights and output are recomputed locally.
5. **Сравнить → Взвесить → Смешать** explains the calculation in three steps.
6. Close Chrome's side panel to return to full-width reading.

The first patch recognizes only equation (1) in **Attention Is All You Need** (`1706.03762`, including versioned PDF URLs). It is a worked example, not a general formula parser or OCR system. Selecting other text, incomplete symbols, another formula or another paper shows an unsupported-selection message. Nothing is sent to an AI service.

The example has three illustrative tokens and two-dimensional vectors (`d_k = 2`). The numbers are **not trained model weights or measurements from the paper**. Q, K and V can be edited; the original mathematical operations are actually recalculated, including numerically stable softmax and the weighted value vector. Reduced-motion preferences are respected.

## Why a context-menu action?

Websites and ordinary extension content scripts cannot add interactive controls inside Chrome's protected PDF viewer. The native selection context-menu API provides the text only after the user chooses the extension's menu item. Therefore this patch uses **select → right-click → explore**. It does not claim to open automatically on selection or to turn the original PDF bytes into an interactive document.

## Permissions and privacy

Chrome 116+ is required for opening a side panel from a context-menu gesture. The user's Chrome 155 is compatible.

- `contextMenus`: adds the explicit action for selected text. The item may appear outside arXiv because the PDF viewer runs in an internal frame; the handler rejects those sources.
- `sidePanel`: shows the controls beside the existing PDF.
- `activeTab`: obtains the source address only following the user's menu/toolbar action.
- `storage`: keeps at most 20 selected formula records in **session memory**, scoped to their individual tabs. Navigation/tab closure removes records; they are not saved to disk as a reading history.

No host permissions, content scripts, cookies, clipboard access, browsing-history permission, MIME handler, account access, API keys, analytics, or network requests are used. The extension's content security policy explicitly blocks network connections and remote code. The panel uses the record for the currently active tab and does not show another tab's selection.

## Build and preview

No npm dependency or PDF rendering library is needed:

```sh
python scripts/build_formula_lens.py
```

The command prints a fresh unpacked extension directory and ZIP under the ignored `.formula-lens-build/` folder. Only the reviewed nine runtime/documentation files are packaged. Backend code, configuration, PDF documents and local user files are excluded.

For a clearly labeled standalone panel preview:

```sh
python scripts/build_formula_lens.py --preview
python scripts/serve_formula_preview.py --directory <the-printed-preview-folder> --port 5079
```

Open `http://127.0.0.1:5079/sidepanel.html?preview=1` and choose **Показать учебный пример**. This previews the controls only. Actual interaction with the native PDF context menu requires installing the extension and is a separate verification step.

## Install for a local test

Review the files and permissions first. Chrome does not install this package automatically.

1. Extract the ZIP into its own folder.
2. Open `chrome://extensions` yourself and enable Developer mode.
3. Choose **Load unpacked** and select the folder containing `manifest.json`.
4. Open the original arXiv link and use the selection's context menu as described above.

Remove the extension on that browser page to remove its menu and panel. No original PDFs or website settings need restoring.

## Sources

- Formula and explanation: Vaswani et al., [Attention Is All You Need, section 3.2.1, equation (1)](https://arxiv.org/pdf/1706.03762).
- [Chrome context-menu API](https://developer.chrome.com/docs/extensions/reference/api/contextMenus) and [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).

This extension is independent of arXiv. It uses no arXiv or ORCID logo.
