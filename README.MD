# Easy ArXiv

Find research papers on arXiv, read an overview, open the original PDF, and explore ideas with AI Quest.

The interface and edge API share this public repository. API keys, OAuth secrets,
user collections, and sessions are never stored in Git. Production runs on
Cloudflare Pages, JavaScript Functions, and D1 using the Free plan; the Python
server remains available for local development.

## Features

- Search by topic, title, paper identifier, or arXiv link, with suggestions and filters.
- Read metadata and follow the original PDF.
- Explore key ideas and check understanding with AI Quest.
- Sign in with ORCID to save a personal reading list of up to 100 papers.
- View monthly statistics from arXiv.
- Use the prepared AI Quest example without an account or API key.

Production generation of new AI Quests requires ORCID sign-in. Daily server-side limits protect the owner's AI quota: initially 10 generations per account and 100 in total. Search, reading, and the prepared example remain available without sign-in. The Laboratory is not included.

## Run locally

Use Python 3.10 or newer:

```sh
python -m venv .venv
# Activate the environment for your operating system.
pip install -r requirements.txt
python -m uvicorn server:app --host 127.0.0.1 --port 5000
```

Open `http://127.0.0.1:5000`. On Windows, `run.ps1` can reuse an existing Python environment. Copy the empty `.env.example` to an untracked `.env` for optional local configuration. Never put secrets into JavaScript, HTML, public JSON, screenshots, or build variables.

Local Python collections use SQLite in `data/`. The Cloudflare production
deployment uses the `DB` D1 binding and encrypted runtime secrets, without
downloadable cloud credentials.

## Deploy

- **Cloudflare Pages:** the static interface, served independently of external APIs.
- **Pages Functions:** the JavaScript API, arXiv integration, ORCID exchange, and AI calls.
- **D1:** persistent account collections, hashed sessions, caches, and daily AI quotas.
- **Encrypted runtime secrets:** API keys available to the Worker, never the browser bundle.

See [deployment instructions](deploy/README.md) and [Cloudflare settings](cloudflare/README.md).
Run `npm ci`, then `python scripts/build_pages.py`; output: `dist`. The build
bundles `cloudflare/edge-worker.mjs` and copies an explicit public asset list.
It excludes `.env`, the Python server, databases, credentials, and unused assets.

Use the Cloudflare Free plan without adding a payment card or enabling paid
upgrades. Its request, CPU, and database quotas are finite. Gemini has its own
provider limits. The retained Dockerfile/Cloud Run option is secondary and is
not required for this deployment.

## Verify

```sh
python -m unittest discover -s tests -p "test_*.py"
npm ci
node --test tests/test_*.mjs tests/test_*.cjs
python scripts/build_pages.py
python scripts/check_public_secrets.py
# Immediately before committing or publishing:
python scripts/check_public_secrets.py --staged --history
```

The scanner reports paths and line numbers only, never matched values. Previously exposed credentials must be revoked even after removing their code. Do not publish a history that fails the check.

## Research sources

Search and statistics use official arXiv services. Featured papers and the prepared AI Quest are examples. Generated notes can be imperfect; verify details against the original work.

Thank you to [arXiv](https://arxiv.org/) for use of its open access interoperability. This service was not reviewed or approved by, nor does it necessarily express or reflect the policies or opinions of, arXiv.
