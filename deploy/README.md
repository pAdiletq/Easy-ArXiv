# Deploy on Cloudflare Free

Use the single public `pAdiletq/Easy-ArXiv` repository for the interface and edge
API. Keep `Esay-Arxiv-Server` as the owner's archive. Do not delete it, change its
visibility, or copy its private files or Git history into this repository.

This deployment uses **Pages + JavaScript Functions + D1**. It does not require
a Google Cloud billing account, Cloud Run, Firestore, a payment card, or a paid
Cloudflare plan. External Gemini calls still use the owner's API quota; hosting
does not include unlimited AI usage.

## Before publishing

Replace any credentials previously exposed in a public repository at their
provider. Deleting the latest file does not revoke a leaked key. Run the staged
and history secret checks from the root README before every publication. A
failed check blocks publishing. Do not rewrite public Git history without an
agreed cleanup plan.

## 1. Create the Pages project

In Cloudflare, choose **Workers & Pages → Create → Pages → Connect to Git** and
select the public repository and production branch. Keep the Free plan.

| Build setting | Value |
| --- | --- |
| Framework | None |
| Root | repository root |
| Command | `python scripts/build_pages.py` |
| Output | `dist` |

Leave Node dependency installation enabled. The lockfile supplies the reviewed
bundler and XML parser. The build only uses public source files; no API secret
is required to produce the artifact. Record the assigned HTTPS Pages origin.

## 2. Create and bind D1

Create a D1 database, for example `easy-arxiv`. Apply the public SQL in
[cloudflare/d1-schema.sql](../cloudflare/d1-schema.sql) using the database console.
The schema creates account collections, hashed sessions and OAuth states,
atomic AI quota counters, and research caches.

In the Pages project's production **Settings → Bindings**, add a D1 database
binding named **`DB`**, selecting that database. Do not use a local SQLite file
as a production fallback. If the binding or schema is missing, account and API
operations must fail visibly rather than appear to save data.

## 3. Configure the runtime

Set the exact production origin in `PUBLIC_ORIGIN`. For ORCID, register that
origin plus `/auth/callback`, and set the identical `ORCID_REDIRECT_URI` and the
public `ORCID_CLIENT_ID`. Keep the existing root callback only if it is the
registered application callback; both paths are handled by the Worker.

Choose `GEMINI_MODEL` from the models enabled for the owner's API project. Start
with `AI_USER_DAILY_LIMIT=10` and `AI_GLOBAL_DAILY_LIMIT=100`. These D1 quotas
reduce abuse but do not replace the AI provider's account limits.

Add **`GOOGLE_API_KEY`** and **`ORCID_CLIENT_SECRET`** under **Variables and Secrets**
using **Encrypt**. Enter their values privately in Cloudflare. Never store them
in GitHub, `.env.example`, HTML, JavaScript, public JSON, build substitutions,
workflow files, shell arguments, screenshots, logs, or chat.

Re-deploy Pages after setting bindings and secrets. Do not copy production
secrets or `DB` into preview environments. Do not enable paid services or
observability that records complete OAuth request URLs/bodies.

## 4. Verify before switching links

- Open every page and refresh `/papers`, `/read`, `/saved`, and `/quest` directly.
- Verify `/health` reports the configured D1 service is healthy.
- Search a real query; upstream unavailability must show an honest error.
- Sign in and out with ORCID on the production domain using secure HTTP-only cookies.
- Save a paper, sign out, sign in again, and confirm it stays in that account.
- Verify a different account cannot read the first account's saved papers.
- Confirm the prepared AI example works anonymously, new generation requires
  ORCID, and quota exhaustion produces a clear response.
- Confirm cross-origin mutations fail and API/auth/callback responses are not cached.
- Run the secret scan on the exact files and Git history being published.

The Free plan has finite limits: currently 100,000 Worker requests per day and
10 ms CPU per invocation. D1 includes 5 million rows read and 100,000 rows written
per day, with 5 GB total storage. CPU time excludes time waiting on network
responses. Load-test real research responses on the deployed free runtime;
passing local tests alone does not prove a workload fits its CPU limit. Keep
the existing public website until these production checks pass.

## Optional Python server

The Python FastAPI implementation and Dockerfile remain for local development
or a future separately approved Cloud Run deployment. They are not used by this
Cloudflare deployment. Cloud Run needs billing and a durable cloud data store;
do not enable it as part of this no-card setup. `cloudflare/pages-worker.mjs`
is the retained optional proxy and is not the production Worker entry point.

Official references: [Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/),
[D1 setup](https://developers.cloudflare.com/d1/get-started/),
[bindings and encrypted secrets](https://developers.cloudflare.com/pages/functions/bindings/),
[Workers Free limits](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 Free limits](https://developers.cloudflare.com/d1/platform/pricing/),
[removing sensitive Git data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
