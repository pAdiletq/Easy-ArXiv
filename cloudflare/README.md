# Cloudflare Pages frontend

The frontend and backend live in the same public repository. The static build
does not read `.env`, credentials, runtime data, or the Python server. The site
keeps all browser API and authentication requests on its own origin.

## Git-connected Pages project

In Cloudflare **Workers & Pages → Create → Pages → Connect to Git**, select the
public `pAdiletq/Easy-ArXiv` repository and its production branch. Use:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Root directory | repository root |
| Build command | `python scripts/build_pages.py` |
| Build output directory | `dist` |

No npm install or frontend dependencies are required. Set the **runtime**
environment variable `BACKEND_ORIGIN` to the exact Cloud Run service origin,
for example `https://SERVICE-PROJECT-NUMBER.REGION.run.app`. Use the real URL
returned by the backend deployment. The worker accepts only HTTPS `*.run.app`
origins without a path, query, user information, or port. It fails closed with a
generic 503 when this value is missing. Re-deploy Pages after changing bindings.

Do not add Google API keys or ORCID client secrets to Cloudflare build variables
or this repository. They belong only in the backend secret store. Configure
the backend's `PUBLIC_ORIGIN` and ORCID callback to match the production Pages
URL or custom domain. Preview deploys can display the interface independently;
do not treat them as separate production OAuth callback origins.

`_worker.js` is built from `pages-worker.mjs`. `_routes.json` invokes it only for
`/api`, `/auth`, their children, and `/`. The root is included to support older
ORCID apps whose registered callback is `/`. A normal home-page request serves
static HTML without contacting Cloud Run. All other page routes and assets are
served directly by Pages. Pages clean URLs map `read.html` to `/read`, and the
same pattern covers `/papers`, `/saved`, `/quest`, and `/ai_quest`.

The proxy preserves request bodies, original browser `Origin` / `Sec-Fetch-Site`,
and authentication cookies. It does not follow OAuth redirects; backend-local
redirect locations become frontend locations. Multiple `Set-Cookie` headers
remain separate. API/auth/callback responses are never cached. Request-provided
forwarding headers are removed. `x-easy-arxiv-public-origin` is informational;
the backend independently checks its configured `PUBLIC_ORIGIN`.

## Checks

```text
python -m unittest discover -s tests -p "test_pages*.py"
node --test tests/test_pages_worker.mjs
python scripts/build_pages.py
```

After deployment, verify that the home page still opens while the backend is
unavailable, search reaches the backend, and ORCID signs in and out at the
frontend URL. Do not upload `dist` by the dashboard drag-and-drop mechanism:
use the Git integration so the advanced-mode worker is deployed too.

Official references: [Advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/),
[Function routing](https://developers.cloudflare.com/pages/functions/routing/),
[GitHub integration](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/),
[Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/),
[Runtime headers](https://developers.cloudflare.com/workers/runtime-apis/headers/).
