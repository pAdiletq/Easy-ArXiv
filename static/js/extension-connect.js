// The website uses its own HttpOnly ORCID session. No account cookie or provider
// credential is read or passed to the extension, and GET never grants access.
const byId = id => document.getElementById(id);
const pairId = new URLSearchParams(location.hash.slice(1)).get('pairId') || '';
let current = null, busy = false, revision = 0;

function status(message) {byId('connectionStatus').textContent = message;}
function controls() {
  byId('approveConnection').disabled = busy || !current?.authenticated || current.approved;
  byId('signIn').hidden = Boolean(current?.authenticated) || !current;
  byId('signInHelp').hidden = byId('signIn').hidden;
  byId('cancelConnection').textContent = current?.approved ? 'Return to Easy ArXiv' : 'Cancel and return to Easy ArXiv';
}
async function refresh() {
  // The extension consumes the approved pair once. Keep this confirmation
  // instead of mistaking that expected deletion for a failed connection.
  if (busy || current?.approved) return;
  const version = ++revision;
  if (!/^[A-Za-z0-9_-]{43}$/.test(pairId)) {
    current = null; controls(); status('This connection link is invalid. Start again from Formula Lens.'); return;
  }
  try {
    const response = await fetch('/api/extension/pair/info?pairId=' + encodeURIComponent(pairId),
      {credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: {Accept: 'application/json'}});
    const data = await response.json();
    if (version !== revision) return;
    if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : 'This connection is unavailable.');
    if (data.pairId !== pairId || !/^[a-p]{32}$/.test(data.extensionId)) throw Error('This connection request is invalid.');
    current = data;
    byId('extensionId').textContent = data.extensionId;
    byId('accountLabel').textContent = data.authenticated ? 'Signed in as ' + (data.user?.name || 'Researcher') : 'Sign in before approving this connection.';
    status(data.approved ? 'Approved. Return to Formula Lens to finish connecting.' : 'Review the access above, then choose whether to connect.');
    controls();
  } catch (error) {
    if (version !== revision) return;
    current = null; controls(); status(error.message || 'The connection could not be checked. Try again.');
  }
}
byId('refreshSession').addEventListener('click', () => void refresh());
byId('approveConnection').addEventListener('click', async () => {
  if (busy || !current?.authenticated || current.approved) return;
  busy = true; revision++; controls(); status('Connecting the extension you approved…');
  try {
    const response = await fetch('/api/extension/pair/approve', {method: 'POST', credentials: 'same-origin',
      redirect: 'error', cache: 'no-store', headers: {'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify({pairId})});
    const data = await response.json();
    if (!response.ok || data.approved !== true) throw Error(typeof data.detail === 'string' ? data.detail : 'This connection could not be approved.');
    current = {...current, approved: true};
    status('Approved. Return to Formula Lens. No paper has been uploaded.');
  } catch (error) {status(error.message || 'This connection could not be approved.');}
  finally {busy = false; controls();}
});
window.addEventListener('focus', () => void refresh());
void refresh();
