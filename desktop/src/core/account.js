'use strict';
// The desktop app's connection to the shared ForgeStudio account: the same projects, conversations and runs as the
// website. This app always calls out to ForgeStudio, so this computer never accepts a connection from the internet.

const API = 'https://robloxforgestudio.base44.app';
const TICK_MS = 10000;
const SIGNED_OUT = 'This desktop app was signed out of your ForgeStudio account. Sign in again.';
const NO_MODEL = 'No local model is chosen in the desktop app. Choose one on its Models page and send the request again.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const utc = (value) => (value && !/([zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value + 'Z' : value);

function createAccount({ state, bridge, ollama, onChange = () => {}, openExternal = () => {}, studioOnline = () => false, device = {}, base = API, fetchImpl = fetch, vault = { seal: (v) => v, open: (v) => v } }) {
  let pending = null;
  let projects = [];
  let shared = { projectId: '', jobs: [] };
  let error = '';
  let timer = null;
  let busy = false;
  let planning = false;
  let treeSent = '';

  const token = () => {
    if (!state.account.token) return '';
    try { return vault.open(state.account.token); } catch (problem) { return ''; }
  };
  const signedIn = () => Boolean(token());
  const active = () => signedIn() && Boolean(state.account.projectId);

  function clear() {
    state.account = { token: '', name: '', projectId: '' };
    state.outbox = [];
    projects = [];
    shared = { projectId: '', jobs: [] };
  }

  async function call(action, payload, auth = true) {
    const body = { action, appVersion: device.appVersion || '', ...(auth ? { token: token() } : {}), ...(payload || {}) };
    const res = await fetchImpl(base + '/functions/deviceSync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    let data = null;
    try { data = await res.json(); } catch (problem) { data = null; }
    if (res.status === 401 && auth) {
      clear();
      onChange();
      throw new Error(SIGNED_OUT);
    }
    if (!res.ok) {
      const failure = new Error((data && data.error) || 'ForgeStudio answered with HTTP ' + res.status);
      failure.status = res.status;
      throw failure;
    }
    return data || {};
  }

  // Sign-in never handles a password here. The app shows a code, the owner approves it on the website, and only
  // then does ForgeStudio hand this app a token.
  async function signIn({ wait = true } = {}) {
    if (signedIn()) return view();
    error = '';
    const started = await call('start', { name: device.name || '', platform: device.platform || '' }, false);
    let address = null;
    try { address = new URL(started.verifyUrl); } catch (problem) { address = null; }
    if (!address || address.origin !== new URL(base).origin) throw new Error('ForgeStudio returned an unexpected sign-in address');
    pending = { userCode: String(started.userCode), verifyUrl: address.href, expires: Date.parse(started.expiresAt), deviceCode: started.deviceCode };
    openExternal(pending.verifyUrl);
    onChange();
    if (wait) waitForApproval((Number(started.interval) || 3) * 1000);
    return view();
  }

  // One check on whether the code has been approved yet. Returns true once this app is signed in.
  async function checkApproval() {
    if (!pending) return false;
    if (Date.now() > pending.expires) {
      pending = null;
      error = 'The sign-in code expired. Start sign-in again.';
      onChange();
      return false;
    }
    let answer = null;
    try {
      answer = await call('token', { deviceCode: pending.deviceCode }, false);
    } catch (problem) {
      if (problem.status !== 401 && problem.status !== 410) return false;
      pending = null;
      error = 'The sign-in code expired. Start sign-in again.';
      onChange();
      return false;
    }
    if (answer.status !== 'active' || typeof answer.token !== 'string') return false;
    state.account = { token: vault.seal(answer.token), name: String((answer.account && answer.account.name) || ''), projectId: '' };
    pending = null;
    await loadProjects().catch((problem) => { error = problem.message; });
    onChange();
    return true;
  }

  async function waitForApproval(interval) {
    while (pending) {
      await sleep(interval);
      if (await checkApproval()) return;
    }
  }

  function openApproval() {
    if (pending) openExternal(pending.verifyUrl);
  }

  async function signOut() {
    if (signedIn()) await call('signOut').catch(() => {});
    pending = null;
    clear();
    onChange();
  }

  async function loadProjects() {
    projects = ((await call('projects')).projects || []).map((p) => ({ id: p.id, name: p.name, planning: p.execution_mode }));
    if (!projects.some((p) => p.id === state.account.projectId)) state.account.projectId = '';
  }

  async function chooseProject(id) {
    if (id && !projects.some((p) => p.id === id)) throw new Error('That project is not in your account');
    state.account.projectId = id || '';
    shared = { projectId: '', jobs: [] };
    onChange();
    await tick();
  }

  // Anything this computer owes the account is kept until ForgeStudio confirms it, and sent again after a lost
  // connection. The server stores each plan and each Studio result once, so a repeat can never apply twice.
  async function flush() {
    while (state.outbox.length > 0) {
      const item = state.outbox[0];
      try {
        await call(item.action, item.payload);
      } catch (problem) {
        if (problem.status !== 404 && problem.status !== 409) throw problem;
      }
      state.outbox.shift();
    }
  }

  function owe(action, payload) {
    state.outbox.push({ action, payload });
    onChange();
  }

  async function plan(work) {
    const model = state.settings.model;
    let outcome = null;
    try {
      if (!model) throw new Error(NO_MODEL);
      outcome = { result: await ollama.chatJson({ model, prompt: work.prompt, schema: work.schema }) };
    } catch (problem) {
      outcome = { error: String((problem && problem.message) || problem).slice(0, 500) };
    }
    owe('submit', { jobId: work.job.id, model: model || '', ...outcome });
    await flush();
  }

  // A request typed in this app: stored in the shared project first, then planned by the model on this computer.
  async function send(prompt) {
    if (!active()) throw new Error('Choose a project on the Account page first');
    const { work } = await call('send', { projectId: state.account.projectId, prompt });
    planning = true;
    onChange();
    try { await plan(work); } finally { planning = false; }
    await tick();
  }

  async function decide(jobId, decision) {
    await call('decide', { jobId, decision });
    await tick();
  }

  // Called by the local Studio link when the plugin reports on a run that came from the shared account.
  function report(run) {
    owe('studioReport', { projectId: run.projectId, jobId: run.id, results: run.results, undoRecorded: run.undoRecorded === true, tree: state.tree || undefined });
    flush().catch((problem) => { error = problem.message; }).then(onChange);
  }

  async function tick() {
    if (busy || !signedIn()) return;
    busy = true;
    try {
      await flush();
      const projectId = state.account.projectId;
      const carrying = state.runs.some((run) => run.remote && (run.status === 'queued' || run.status === 'running'));
      const linked = Boolean(projectId) && studioOnline() && !carrying;
      const treeKey = state.treeAt || '';
      const sendTree = linked && state.tree && treeKey !== treeSent;
      const out = await call('sync', {
        projectId: projectId || undefined,
        wantWork: Boolean(state.settings.model) && !planning,
        studioOnline: linked,
        tree: sendTree ? state.tree : undefined,
      });
      if (sendTree) treeSent = treeKey;
      if (out.job) bridge.addRemote({ id: out.job.id, projectId, operations: out.job.operations });
      if (projectId && state.account.projectId === projectId) shared = { projectId, jobs: out.jobs || [] };
      if (out.work) {
        planning = true;
        onChange();
        try { await plan(out.work); } finally { planning = false; }
      }
      error = '';
    } catch (problem) {
      error = problem.message;
    } finally {
      busy = false;
      onChange();
    }
  }

  function start() {
    if (timer) return;
    if (signedIn()) loadProjects().catch((problem) => { error = problem.message; }).then(tick);
    timer = setInterval(tick, TICK_MS);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    pending = null;
  }

  // The open project's conversation in the shape the Build page draws, or null when working without the account.
  function runs() {
    if (!active() || shared.projectId !== state.account.projectId) return active() ? [] : null;
    return shared.jobs.map((job) => ({
      id: job.id, prompt: job.prompt, reply: job.reply || '', plan: job.plan || [], operations: job.operations || [],
      model: job.model || (job.mode === 'cloud' ? 'hosted model' : ''), status: job.status, results: job.results || [],
      error: job.error || '', undoRecorded: job.undo_recorded === true, createdAt: utc(job.created_date), source: job.source,
    }));
  }

  function view() {
    return {
      signedIn: signedIn(), name: state.account.name, projectId: state.account.projectId, projects, error, planning,
      pending: pending ? { userCode: pending.userCode, expires: pending.expires } : null,
    };
  }

  return { signIn, checkApproval, openApproval, signOut, loadProjects, chooseProject, send, decide, report, tick, start, stop, runs, view, active };
}

module.exports = { createAccount, API, SIGNED_OUT, NO_MODEL };
