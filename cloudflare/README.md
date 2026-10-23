# Cloudflare Pages, Functions, and D1

The production deployment uses Cloudflare's Free plan: Pages serves the existing
interface and an advanced-mode JavaScript Worker handles the API, ORCID, and
AI requests. D1 stores sessions, reading lists, quotas, and caches. A separate
Python host, Google Cloud billing account, or `BACKEND_ORIGIN` is not needed.

## Pages project

Connect `pAdiletq/Easy-ArXiv` with Pages' Git integration and select the production
branch. Use these settings:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Root directory | repository root |
| Build command | `python scripts/build_pages.py` |
| Build output directory | `dist` |

Keep dependency installation enabled. The repository's `package-lock.json` pins
the Node dependencies. For a local build, run `npm ci` first and ensure Node.js
and Python 3.10+ are on PATH. The build fails if Node or the local esbuild package
is missing; it never substitutes the older proxy worker.

`scripts/build_worker.mjs` bundles `cloudflare/edge-worker.mjs` as a minified
ES2022 module. It uses the esbuild JavaScript API, with no `.env` loader, environment
substitutions, or source maps. `scripts/build_pages.py` copies an explicit list
of public assets and produces `dist/_worker.js`. The Python API, local databases,
dotfiles, credentials, and unused generated images are excluded.

`_routes.json` invokes the Worker for `/api`, `/auth`, their children, `/health`,
and `/`. The root handles older ORCID apps with a `/` callback; normal home-page
requests serve static HTML without contacting D1 or an external AI provider.
Other HTML, CSS, JavaScript, and images are served directly by Pages. Clean URLs
cover `/papers`, `/read`, `/saved`, `/quest`, and `/ai_quest`.

## Database and runtime bindings

Create a D1 database and apply [d1-schema.sql](d1-schema.sql) in its dashboard
console. Bind it to the Pages **production** environment using the name `DB`:
**Settings → Bindings → Add → D1 database**. D1 database identifiers are not API
tokens, but no private credentials are needed in the repository to use bindings.

Set these production runtime variables under **Settings → Variables and Secrets**:

| Name | Value |
| --- | --- |
| `PUBLIC_ORIGIN` | exact production HTTPS Pages URL or custom origin, with no path |
| `ORCID_CLIENT_ID` | public application client ID |
| `ORCID_REDIRECT_URI` | `PUBLIC_ORIGIN/auth/callback`; register this exact URL with ORCID |
| `GEMINI_MODEL` | model enabled for the owner's Gemini API project |
| `AI_USER_DAILY_LIMIT` | `10` initially |
| `AI_GLOBAL_DAILY_LIMIT` | `100` initially |

Add `ORCID_CLIENT_SECRET` and `GOOGLE_API_KEY` as **encrypted secrets**, never as
plain text build variables or repository files. These values are only used by
the runtime Worker. Enter them in Cloudflare's private secret fields, not in
source, shell arguments, screenshots, logs, or chat. Re-deploy after changing
bindings or secrets.

Leave production database bindings and secrets out of preview environments.
Preview pages can display the interface; only the configured production origin
may perform account actions. Keep OAuth access logs and request-body logging
disabled to avoid recording temporary authorization codes.

## Checks

```sh
npm ci
python -m unittest discover -s tests -p "test_pages*.py"
node --test tests/test_*.mjs tests/test_*.cjs
python scripts/build_pages.py
python scripts/check_public_secrets.py
```

After deployment, verify `/health`, real arXiv search, ORCID login/logout, and
account-scoped saved papers. New AI generations require login and respect D1
quotas; the prepared example remains available to guests. The AI Worker passes
the validated original arXiv PDF URL to Gemini for study notes and questions.
An unreadable or unsupported PDF produces an error, not invented replacement
content. Keep the project on the Free plan and monitor its runtime limits.

Use Git integration rather than dashboard drag-and-drop so Pages deploys the
advanced worker with the static files. The retained `pages-worker.mjs` is an
optional older Cloud Run proxy; it is not bundled by the production build.

Official references: [Advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/),
[Function routing](https://developers.cloudflare.com/pages/functions/routing/),
[D1 bindings and encrypted secrets](https://developers.cloudflare.com/pages/functions/bindings/),
[GitHub integration](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/),
[Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/).
