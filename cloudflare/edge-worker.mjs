import {EdgeStore, EdgeError, handleAuth, edgeJSON} from './edge-auth.mjs';
import {ResearchError, handleResearch} from './edge-research.mjs';
import {QuestError, handleAI} from './edge-ai.mjs';
import {handleFormulaExtension} from './edge-formula-auth.mjs';
import {handleFormulaAI, FormulaAIError} from './edge-formula.mjs';

function publicOrigin(env) {
  try {
    const url = new URL(env.PUBLIC_ORIGIN);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      !url.search && !url.hash && url.pathname === '/' && env.PUBLIC_ORIGIN === url.origin ? url.origin : null;
  } catch { return null; }
}

function isAPI(url) {
  return url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/health' ||
    url.pathname === '/auth' || url.pathname.startsWith('/auth/') ||
    (url.pathname === '/' && ['code', 'state', 'error'].some(key => url.searchParams.has(key)));
}

export async function handleRequest(request, env, deps = {}) {
  const url = new URL(request.url);
  if (!isAPI(url)) return env.ASSETS.fetch(request);
  // Preview URLs may show the public design, but must not accept production
  // account cookies or start production OAuth flows.
  if (!publicOrigin(env) || url.origin !== publicOrigin(env)) {
    return edgeJSON({detail: 'Use the main Easy ArXiv website for this request.'}, 403);
  }
  try {
    const orcid = Boolean(env.ORCID_CLIENT_ID && env.ORCID_CLIENT_SECRET &&
      [env.PUBLIC_ORIGIN + '/auth/callback', env.PUBLIC_ORIGIN + '/'].includes(env.ORCID_REDIRECT_URI));
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return edgeJSON({ai_quest_configured: Boolean(env.GOOGLE_API_KEY || env.GEMINI_API_KEY),
        ai_quest_requires_login: true, orcid_configured: orcid,
        orcid_login_url: orcid ? '/auth/login' : null,
        orcid_redirect_uri: orcid ? env.ORCID_REDIRECT_URI : null});
    }
    if (!env.DB) return edgeJSON({detail: 'The research service is temporarily unavailable. Please try again shortly.'}, 503);
    const store = new EdgeStore(env.DB);
    if (url.pathname === '/health' && request.method === 'GET') {
      await store.probe();
      return edgeJSON({status: 'ok', app: 'easy-arxiv-web'});
    }
    if (url.pathname === '/' && ['code', 'state', 'error'].some(key => url.searchParams.has(key))) {
      url.pathname = '/auth/callback';
      request = new Request(url, request);
    }
    const context = {...deps, store};
    return await handleFormulaExtension(request, env, context, {handleAI: handleFormulaAI,
      isSafeAIError: error => error instanceof FormulaAIError}) ||
      await handleAuth(request, env, context) || await handleAI(request, env, context) ||
      await handleResearch(request, env, context) || edgeJSON({detail: 'Not found.'}, 404);
  } catch (error) {
    // Only handler errors with an explicit safe status/message reach clients.
    // D1/provider exception text can contain request data and is never exposed.
    const known = error instanceof QuestError || error instanceof ResearchError || error instanceof EdgeError;
    if (known && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
      return edgeJSON({detail: error.message}, error.status);
    }
    return edgeJSON({detail: 'The research service is temporarily unavailable. Please try again shortly.'}, 503);
  }
}

export default {fetch: handleRequest};
