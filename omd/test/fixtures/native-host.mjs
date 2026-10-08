import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
export const nativeHosts = [
  { version: '0.2.0-rc.2', cliEnv: 'OMD_NATIVE_RC_CLI' },
  { version: '0.2.1-alpha.1', cliEnv: 'OMD_NATIVE_ALPHA_CLI' },
];
export function resolveNativeConfiguration(host, env = process.env) {
  if (env.OMD_CHECKOUT && !isAbsolute(env.OMD_CHECKOUT)) throw Error('OMD_CHECKOUT must be an absolute path');
  const checkoutRequire = env.OMD_CHECKOUT && createRequire(join(env.OMD_CHECKOUT, 'package.json'));
  const fromCheckout = name => {
    try { return checkoutRequire.resolve(name); }
    catch (error) { throw Error(`Cannot resolve ${name} from OMD_CHECKOUT: ${error.message}`); }
  };
  const cli = env[host.cliEnv] || (host.cliEnv === 'OMD_NATIVE_ALPHA_CLI' && checkoutRequire ? fromCheckout('@deepseek-ai/dsh/lib/bin.js') : undefined);
  if (!cli) throw Error(`Missing ${host.cliEnv}${host.cliEnv === 'OMD_NATIVE_ALPHA_CLI' ? ' (or explicit OMD_CHECKOUT)' : ''}`);
  if (!isAbsolute(cli)) throw Error(`${host.cliEnv} must be an absolute CLI entry path`);
  const playwrightEntry = env.OMD_NATIVE_PLAYWRIGHT || (checkoutRequire ? fromCheckout('playwright') : undefined);
  if (!playwrightEntry) throw Error('Missing OMD_NATIVE_PLAYWRIGHT (absolute module entry path) or explicit OMD_CHECKOUT');
  if (!isAbsolute(playwrightEntry)) throw Error('OMD_NATIVE_PLAYWRIGHT must be an absolute module entry path');
  if (env.OMD_NATIVE_CHROMIUM && !isAbsolute(env.OMD_NATIVE_CHROMIUM)) throw Error('OMD_NATIVE_CHROMIUM must be an absolute browser executable path');
  return { cli, playwrightEntry, executablePath: env.OMD_NATIVE_CHROMIUM };
}
export async function until(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(50); }
  throw Error('Native host fixture timed out');
}
const redact = value => String(value).replace(/token=[\w-]+/g, 'token=[redacted]');
export async function nativeHostFixture(t, host, { packagePath, install = true, modelReply } = {}) {
  // Validate every runtime input before creating temporary state or a provider.
  const runtime = resolveNativeConfiguration(host);
  const cli = await realpath(runtime.cli);
  const cliManifest = JSON.parse(await readFile(join(dirname(dirname(cli)), 'package.json'), 'utf8'));
  if (cliManifest.version !== host.version) throw Error(`CLI version mismatch: ${cliManifest.version} != ${host.version}`);
  const playwrightEntry = await realpath(runtime.playwrightEntry);
  const playwright = await import(pathToFileURL(playwrightEntry).href);
  const chromium = playwright.chromium || playwright.default?.chromium;
  if (typeof chromium?.launch !== 'function') throw Error('OMD_NATIVE_PLAYWRIGHT does not export chromium.launch');
  const executablePath = await realpath(runtime.executablePath || chromium.executablePath()).catch(error => { throw Error(`Browser executable unavailable; set OMD_NATIVE_CHROMIUM or install Playwright Chromium: ${error.message}`); });
  if (install && !packagePath) throw Error('Missing OMD_INTENT_PACKAGE');
  const tarballSha = install ? createHash('sha256').update(await readFile(packagePath)).digest('hex') : undefined;
  const root = await mkdtemp(join(tmpdir(), 'intent-native-')), dshRoot = join(root, 'dsh'), workspace = join(root, 'workspace');
  await mkdir(dshRoot); await mkdir(workspace);
  // Deliberately do not inherit account/model keys, NODE_OPTIONS, proxy settings,
  // DSH overrides, or the caller's selected profile. All DSH state belongs to the empty DSH_HOME.
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { DSH_HOME: dshRoot, DSH_PERMISSION_MODE: 'danger-full-access' });
  const profile = 'intent-native', profileDir = join(dshRoot, 'profiles', profile), errors = [], resources = [], requests = [];
  let child, browser, context, page, origin, cookie = '', log = '';
  const provider = createServer(async (req, res) => {
    try {
      if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw); requests.push(payload);
      const choice = await modelReply?.(payload, req, res) || { delta: { role: 'assistant', content: 'NATIVE_FIXTURE_OK' }, finish_reason: 'stop' };
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ id: 'native-fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, ...choice }] }) + '\n\ndata: [DONE]\n\n');
    } catch (error) { errors.push('provider: ' + error.stack); if (!res.destroyed) { res.writeHead(500); res.end('fixture error'); } }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const command = async args => {
    try { return await execute(process.execPath, [cli, ...args], { cwd: workspace, env, timeout: 180000, maxBuffer: 16 * 1024 * 1024 }); }
    catch (error) { error.message = redact(error.stderr || error.stdout || error.message); throw error; }
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
    await Promise.race([exited, delay(5000, undefined, { ref: false })]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
  };
  t.after(async () => {
    if (!t.passed) t.diagnostic(JSON.stringify({ host: host.version, root, log: redact(log), errors, resources, body: await page?.locator('body').innerText().catch(() => '') }));
    await browser?.close(); await stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    if (!process.env.OMD_NATIVE_KEEP) await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(dshRoot, 'settings.yaml'), JSON.stringify({
    locale: { preference: 'zh' },
    'llm-pi-ai': { providers: { fixture: { api: 'openai-completions', baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKeyEnv: 'INTENT_NATIVE_FIXTURE', models: [{ id: 'fixture', name: 'Native fixture', contextWindow: 1000000, maxTokens: 8192, input: ['text', 'image'] }] } } },
    'agent-default-model': { provider: 'fixture', model: 'fixture' },
  }));
  await writeFile(join(dshRoot, '.credentials.yaml'), JSON.stringify({ version: 1, refs: { INTENT_NATIVE_FIXTURE: 'local-test-only' } }), { mode: 0o600 });
  await command(['--profile', profile, '--from-default-profile', 'web', '--dump-config']);
  if (install) await command(['plugin', '--profile', profile, 'add', 'file:' + packagePath]);
  // Stock profiles resolve in-box packages through DSH's runtime table rather
  // than physical profile/node_modules links. Read the target host's own table.
  const bootEntry = createRequire(cli).resolve('@deepseek-ai/dsh-app-boot');
  const boot = await import(pathToFileURL(bootEntry).href);
  const installAnchor = join(dirname(dirname(cli)), 'package.json');
  const loadedProfile = boot.loadProfileDirectory('dsh', profileDir, installAnchor);
  const resolution = await boot.createRuntimeResolution({ installAnchor, profile: loadedProfile, home: dshRoot });
  const sdk = await Promise.all(['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-conversation'].map(async name => {
    const row = resolution.entries.find(item => item.name === name);
    if (!row) throw Error('Runtime table lacks ' + name);
    return { name, version: row.version, directory: await realpath(row.packageDir), declarer: row.declarer, scope: row.scope };
  }));
  for (const item of sdk) if (item.version !== host.version) throw Error(`Profile SDK mismatch: ${item.name} ${item.version}`);
  const evidence = { cli: { version: cliManifest.version, entry: cli }, browser: { playwrightEntry, executablePath }, profileDir, sdk, versionBypass: false, linkedSource: false, ...(install ? { tarball: packagePath, sha256: tarballSha } : {}) };
  const request = async (path, options) => fetch(origin + path, { ...options, headers: { cookie, ...options?.headers } });
  const call = async (method, args = {}) => {
    const res = await request('/api/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }) });
    const value = await res.json(); if (!value.result?.ok) throw Error(JSON.stringify(value) + '\n' + redact(log)); return value.result.value;
  };
  const rpc = (method, value) => call(method, value === undefined ? {} : { request: value });
  const start = async () => {
    log = ''; child = spawn(process.execPath, [cli, '--profile', profile, '--no-open', '--port', '0'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-30000); });
    const bootstrap = await until(() => { if (child.exitCode !== null) throw Error(redact(log)); return log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)?.[0]; }, 60000);
    origin = new URL(bootstrap).origin;
    const response = await fetch(bootstrap, { redirect: 'manual' }); cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    await until(async () => (await rpc('llm/listProviders')).some(p => p.id === 'fixture'));
  };
  const open = async () => {
    if (!browser) {
      browser = await chromium.launch({ headless: true, executablePath, args: ['--use-mock-keychain', '--password-store=basic'] });
    }
    await context?.close(); context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
    await context.addCookies(cookie.split('; ').filter(Boolean).map(value => { const split = value.indexOf('='); return { name: value.slice(0, split), value: value.slice(split + 1), url: origin }; }));
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.stack || error.message));
    page.on('response', async res => { if (/plugins|session\/prompt|omd-intent\/api\/stage/.test(res.url())) resources.push({ url: res.url(), status: res.status(), ...res.url().includes('/api/') ? { body: await res.text().catch(() => '') } : {} }); });
    await page.goto(origin);
    const welcome = page.getByRole('button', { name: '继续', exact: true });
    await until(async () => await welcome.count() || await page.locator('textarea,[contenteditable=true]').count());
    if (await welcome.isVisible()) { await welcome.click(); await welcome.waitFor({ state: 'hidden' }); }
    return page;
  };
  await start();
  return { root, dshRoot, workspace, profileDir, requests, evidence, errors, resources, command, request, call, rpc, start, stop, open, get page() { return page; }, get origin() { return origin; }, log: () => redact(log), async restart() { await context?.close(); context = null; await stop(); await start(); return open(); } };
}
