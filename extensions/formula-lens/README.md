# Easy ArXiv — Formula Lens

An optional Chrome side panel for understanding a selected formula **in the context of its paper**. Chrome keeps its ordinary PDF viewer and the exact original PDF address. The extension does not replace the viewer, rewrite the file, intercept downloads, or add controls inside the PDF.

## Current status

The article-analysis workflow is an experimental local implementation. **Hosted article analysis is disabled by its backend feature flag and has not been deployed.** A local package or interface preview does not mean the service is available. The UI must report unavailable service or missing evidence honestly; it must not substitute a prepared answer and call the paper analyzed.

The current JSON/base64 upload path still needs a transport change and native runtime profiling before it can be enabled within Cloudflare Free's CPU budget. A successful local test does not establish production capacity for a 6 MiB PDF.

## Intended workflow

1. Open the original paper PDF over HTTPS in Chrome desktop 116 or later.
2. Open Formula Lens using its toolbar button or a selected formula’s context menu.
3. Choose **Analyze paper**. If prompted, sign in with ORCID on Easy ArXiv and explicitly approve the extension connection.
4. Review the transmission notice before continuing. Analysis reads the selected original PDF, not a replacement webpage or an abstract-only sample.
5. Select the formula in the native PDF viewer, open Formula Lens from the right-click menu, and check the copied expression.
6. Choose **Explain formula**. Paper-grounded output is organized as **Purpose**, **Applications**, **Worked example**, and **Conclusion**. Expand **From the paper** to inspect supporting passages and references.

The current tab and its source must still match when a PDF is read. Switching or navigating the paper tab can cancel the operation. No background analysis should start simply because a PDF is opened or text is selected.

## Data transfer and connection

**After the explicit analysis action, the original PDF (up to 6 MiB / 6,291,456 bytes), the selected formula and the request are sent to Easy ArXiv and Google Gemini for analysis.** Provider processing is external to the device. Do not analyze a confidential paper unless you are permitted to send it to those services.

In the current implementation, **Analyze paper** sends the complete PDF, and **Explain formula sends the same complete PDF again** with the selected formula. This is not a one-time upload reused automatically for every explanation.

The packaged API client uses only the fixed service origin `https://easy-arxiv.pages.dev` and its reviewed extension endpoints. It does not accept an arbitrary server address. Source download is limited to the active, selected original HTTPS PDF; HTTP sources, redirects and oversized documents are rejected. The full document must fit the limit: it is not silently truncated.

The extension uses no embedded Gemini key, server key or ORCID client secret. ORCID sign-in and approval happen on the Easy ArXiv website. A proof-based pairing flow returns a scoped bearer grant intended to last **20 minutes**, stored only in Chrome’s `storage.session`. The extension sends that grant to the fixed API with credentials omitted; it does not read or forward website cookies. Signing out of Easy ArXiv revokes the associated extension access. Browser-session storage is not a persistent sign-in or a reading-history database.

Downloading the source PDF also omits cookies and referrer information. Authenticated or paywalled PDFs that require browser cookies are consequently outside this workflow.

Easy ArXiv retains the account-scoped AI context and explanations for up to 24 hours. It does not persist the raw PDF. Google processes the supplied document separately; the extension does not imply that provider processing stays on the device.

## What an explanation can and cannot establish

- The formula’s meaning depends on definitions, assumptions and discussion in the paper. A mathematical expression alone does not establish its scientific purpose.
- Provider-generated explanations and cited evidence can be incomplete or mistaken. Check the original passages, page references and assumptions before relying on them.
- A **Worked example** may use explicitly illustrative values. Those values are not claimed to be measurements, learned weights or experimental findings from the paper.
- Scanned or image-only PDFs, password-protected documents, unreadable symbols, unsupported notation and papers larger than 6 MiB are not supported by this prototype. A selectable formula may still need manual correction after copying.
- Some public HTTPS PDF servers block extension downloads or return redirects instead of the document. The panel should show the actual failure rather than analyze different material.
- If the provider cannot explain a formula from the available evidence, the UI must say so. A generic graph is not a substitute for an article-grounded explanation.

**Expression sandbox** is a separate, closed numerical tool. Its local parser and worker can explore supported expressions with illustrative parameters. Its results do not establish a formula’s role in a scientific paper. A graph or numerical experiment appears only when explicitly opened and must identify what its axes and values represent.

## Permissions and execution boundaries

The manifest retains exactly four permissions:

- `contextMenus`: provides the explicit selected-text action. Chrome’s internal PDF frame can affect menu filtering; the handler validates the source before using it.
- `sidePanel`: displays the panel beside the original PDF.
- `activeTab`: temporarily grants access to the active source after a user action.
- `storage`: holds bounded per-tab selections and the short-lived connection in session storage. It is not used to store provider keys or a persistent document library.

There are no host permissions, content scripts, MIME handler, clipboard permission, browsing-history permission or cookie permission. The content policy permits HTTPS connections for the selected source and fixed service, while executable scripts and the calculation worker remain packaged locally. It does not permit remote scripts or evaluation of downloaded code.

The packaging guard permits fetch calls only in `api-client.js` and `paper-fetch.js`. It continues to reject other network primitives, evaluation calls and unreviewed worker paths. Endpoint, source, grant and response checks are implemented and tested in those reviewed modules; a static packaging guard is not a substitute for runtime validation.

## Build and interface preview

No npm dependency or alternate PDF rendering library is needed:

```sh
python scripts/build_formula_lens.py
```

The command prints an unpacked extension directory and ZIP under the ignored `.formula-lens-build/` folder. A fixed allowlist includes the reviewed runtime, README and local icons. Backend code, environment files, source PDFs and unrelated local files are excluded.

For a separate, labeled interface preview:

```sh
python scripts/build_formula_lens.py --preview
python scripts/serve_formula_preview.py --directory <printed-preview-folder> --port 5079
```

Open `http://127.0.0.1:5079/sidepanel.html?preview=1`. Preview fixtures and numerical examples do not contact the AI service or claim that an article was analyzed. Native PDF interaction, active-tab access, ORCID pairing and hosted analysis require separate testing in the installed extension and an explicitly enabled backend.

## Optional installation

This ZIP is a local test package, not a Chrome Web Store listing. Installation is a user action:

1. Extract the ZIP into its own folder.
2. Open `chrome://extensions` and enable Developer mode.
3. Choose **Load unpacked**, then select the folder containing `manifest.json`.
4. Open the original PDF and open Formula Lens from the toolbar or selection menu.

Keep Developer mode enabled while testing this unpacked package. Since Chrome 134, switching it off disables unpacked extensions loaded from `chrome://extensions`, as confirmed in the [Chrome Extensions team announcement](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/cTdMVtxxooY).

For normal distribution to users, use a reviewed, signed Chrome Web Store release. An unpacked ZIP is a developer test package, not the ordinary installation path. See [Chrome’s distribution guidance](https://developer.chrome.com/docs/extensions/how-to/distribute).

Close the panel to return to full-width reading. Remove the extension in Chrome to remove its menu and panel. The original PDFs and their addresses remain unchanged.

Formula Lens is independent of arXiv and ORCID and uses neither organization’s logo. API keys and server secrets belong in the service’s secret configuration, never in this extension or its public repository.
