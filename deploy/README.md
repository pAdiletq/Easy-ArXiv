# Cloudflare Pages and Cloud Run deployment

Use the public `pAdiletq/Easy-ArXiv` repository for both services. Keep the old server repository separately. Do not delete it, change its visibility, or import its private files or Git history here.

## Before publishing

Revoke secrets previously committed to Git. Old public ORCID secrets must be replaced in ORCID Developer Tools; removing their latest file does not revoke them. Run the staged and history checks from the root README. A failed check blocks publishing. Agree on cleanup before rewriting any public branch.

Sign in to Cloudflare and Google Cloud. Google requires two-step verification. The account owner should complete account security changes, payment setup, and acceptance of terms.

## Frontend

Connect this repository to Cloudflare Pages through its Git integration. Framework: **None**. Build: `python scripts/build_pages.py`. Output: **dist**. Root: repository root. No API key is needed in the build. Record the assigned HTTPS Pages origin for `PUBLIC_ORIGIN` below.

The interface can be deployed before the backend is configured, but do not call deployment complete until API, authentication, and persistence checks pass. See [the frontend guide](../cloudflare/README.md).

## Google project

Use a dedicated project and billing account explicitly approved by the owner. Enable Cloud Run, Artifact Registry, Cloud Build, Firestore, and Secret Manager as required. Source builds and image storage have separate pricing; review the whole project's billing.

Create a **Firestore Native** database with ID `(default)`, near the Cloud Run region. Its location cannot be freely changed later. Use locked production rules: browsers do not directly access Firestore.

Use a dedicated Cloud Run runtime service account. Grant `roles/datastore.user` for this project and Secret Manager Secret Accessor only on the required individual secrets. Review IAM grants before applying them. Do not create downloadable service-account JSON keys.

Expiry is checked by the application on every auth read. Firestore TTL cleanup is optional and can incur charges; do not enable it as an assumed free feature.

## Runtime environment

| Variable | Value |
| --- | --- |
| `APP_ENV` | `production` |
| `SAVED_STORE` | `firestore` |
| `GOOGLE_CLOUD_PROJECT` | actual project ID |
| `FIRESTORE_DATABASE` | `(default)` |
| `PUBLIC_ORIGIN` | exact production HTTPS Pages/custom origin, no path |
| `ORCID_CLIENT_ID` | application's public client ID |
| `ORCID_REDIRECT_URI` | `PUBLIC_ORIGIN/auth/callback`, also register this exact URL in ORCID |
| `GEMINI_MODEL` | a model enabled for the owner's Gemini project |
| `AI_USER_DAILY_LIMIT` | `10` initially |
| `AI_GLOBAL_DAILY_LIMIT` | `100` initially |

Create secrets **easy-arxiv-gemini-key** and **easy-arxiv-orcid-secret** in Secret Manager. Attach specific versions to runtime variables `GOOGLE_API_KEY` and `ORCID_CLIENT_SECRET`. Enter values through the private provider interface, never Git, manifests, shell arguments, build logs, or chat. `.env.example` contains empty placeholders only.

## Cloud Run

Build from this repository's Dockerfile. Its context excludes Git, `.env`, credentials, databases, tests, and unrelated files. The runtime is non-root, listens on `$PORT`, and disables application URL access logs to avoid logging OAuth callback codes.

Initial settings: 1 vCPU, 512 MiB RAM, minimum instances **0**, maximum instances **1**, concurrency **8**, request timeout **120 seconds**. Use `/health` as a startup probe after Firestore and secrets are configured. Health fails if durable storage is unavailable; it never substitutes an ephemeral database.

Allow public invocation only after the owner approves public exposure. The Pages proxy calls this API; account actions require authentication and CSRF checks. Instance limits and AI quotas are not a hard Google Cloud spending cap. Keep minimum instances at zero initially; the frontend is independent of backend cold starts.

Set Pages runtime `BACKEND_ORIGIN` to the real HTTPS `*.run.app` origin, then redeploy Pages. No API key or ORCID secret belongs in Pages variables.

## Verification before switching public links

- All pages render from Pages even while Python is unavailable.
- Search reaches the real arXiv API; upstream failure is reported honestly.
- ORCID login/logout use the frontend domain, registered callback, and secure HTTP-only cookies. Config/browser responses contain no secrets.
- Saved papers remain account-scoped after a Cloud Run restart or revision.
- The prepared example works anonymously; new AI generation requires login and respects durable daily quotas.
- Cross-origin mutations fail, API/auth responses are not cached, and `/health` succeeds.
- Review provider usage and billing before promoting the new URL.

Keep the existing website and server repository while verifying the new deployment. Only then update the Product Hunt website link.

Official references: [Cloudflare Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/), [Cloud Run](https://cloud.google.com/run/docs/deploying), [secrets](https://cloud.google.com/run/docs/configuring/services/secrets), [service identity](https://cloud.google.com/run/docs/securing/service-identity), [Firestore pricing](https://cloud.google.com/firestore/pricing), [removing sensitive Git data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
