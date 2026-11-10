<div align="center">

<img src="static/brand.svg" width="72" height="72" alt="Easy ArXiv book icon">

# Easy ArXiv

**Find your next paper. Understand the ideas.**

Search arXiv, read the original research, and check your understanding with AI Quest.

<p>
  <a href="https://easy-arxiv.pages.dev"><strong>Open Easy ArXiv ↗</strong></a>
  &nbsp;·&nbsp;
  <a href="https://www.producthunt.com/products/easy-arxiv">Product Hunt</a>
  &nbsp;·&nbsp;
  <a href="#run-locally">Run locally</a>
  &nbsp;·&nbsp;
  <a href="#formula-lens"><img src="https://img.shields.io/badge/Formula_Lens-Explore-8000FF?style=for-the-badge" height="28" alt="Explore Formula Lens"></a>
</p>

</div>

---

## From a question to a reading list

| Step | What you can do |
| --- | --- |
| **01 · Discover** | Search by topic, title, paper ID, or arXiv link. Narrow the results with suggestions, dates, and sorting. |
| **02 · Read** | Explore paper details and open the original arXiv PDF. Browse monthly submission statistics along the way. |
| **03 · Understand** | Use **AI Quest** to work through key ideas and quiz questions grounded in a paper. |
| **04 · Return** | Sign in with **ORCID** and keep up to 100 papers in your personal reading list. |

Search, reading, and a prepared AI Quest example are available to guests. Generating a new Quest requires ORCID sign-in and available AI quota. Generated explanations should be checked against the original research.

## Formula Lens

> An optional Chrome side panel for exploring a formula beside the original PDF.

**The website works without installing the extension.** Formula Lens is an additional tool for readers who want to experiment beside a PDF.

The preview supports numerical experiments with supported expressions, editable inputs, suitable plots, and an animated worked example. General article-aware interpretation remains in development; arbitrary equations may require correction or may be unsupported.

The extension's source code and installation packages are not published in this repository.

## Run locally

Use **Python 3.10+** from the repository root:

```sh
python -m venv .venv
# Activate .venv for your operating system, then:
python -m pip install -r requirements.txt
python -m uvicorn server:app --host 127.0.0.1 --port 5000
```

Open **http://127.0.0.1:5000**. On Windows, [`run.ps1`](run.ps1) can reuse an existing Python environment.

For optional local Gemini and ORCID settings, copy the empty [configuration template](.env.example) to an ignored `.env`. Local reading lists use SQLite in `data/`.

## Deploy

The live app uses Cloudflare Pages and persistent account storage. The Cloudflare implementation and deployment instructions are maintained outside this public repository. The public checkout retains the Python application and website interface for local development.

<details>
<summary><strong>Development checks and safe publishing</strong></summary>

Some edge tests and the Pages build require the separately maintained Cloudflare files.

```sh
npm ci
python -m unittest discover -s tests -p "test_*.py"
python scripts/check_public_secrets.py
# Check the exact staged files and history before publishing:
python scripts/check_public_secrets.py --staged --history
```

Keep API keys, OAuth secrets, populated `.env` files, databases, and user data out of Git. Never place credentials in public JSON, frontend code, build substitutions, or screenshots. The scanner reports locations without printing matched values. Revoke any previously exposed credential at its provider; removing a file does not revoke it.

</details>

## Research sources

Search and statistics use official arXiv services. Featured papers and the prepared Quest are examples. Easy ArXiv is an independent project.

Thank you to [arXiv](https://arxiv.org/) for use of its open access interoperability. This service was not reviewed or approved by, nor does it necessarily express or reflect the policies or opinions of, arXiv.
