# Easy ArXiv

Find research papers on arXiv, read an overview, open the original PDF, and explore ideas with AI Quest.

The interface and Python API share this public repository. API keys, OAuth secrets, user collections, and sessions are never stored in Git.

## Features

- Search by topic, title, paper identifier, or arXiv link, with suggestions and filters.
- Read metadata and follow the original PDF.
- Explore key ideas and check understanding with AI Quest.
- Sign in with ORCID to save a personal reading list.
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

Local collections use SQLite in `data/`. Cloud deployments use Firestore and the attached Cloud Run service identity, without downloadable credentials.

## Deploy

- **Cloudflare Pages:** static interface and same-origin API proxy.
- **Cloud Run:** Python API, arXiv integration, ORCID exchange, and AI calls.
- **Firestore:** persistent account collections and sessions.
- **Secret Manager:** runtime secrets available only to the backend identity.

See [deployment instructions](deploy/README.md) and [Cloudflare settings](cloudflare/README.md). Frontend build: `python scripts/build_pages.py`; output: `dist`. The build uses an explicit allowlist and excludes `.env`, server code, databases, and credentials.

Free quotas are not a guaranteed zero bill. Cloud Run requires an enabled billing account. These source files do not create billing accounts, paid plans, IAM grants, or deployments by themselves.

## Verify

```sh
python -m unittest discover -s tests -p "test_*.py"
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
