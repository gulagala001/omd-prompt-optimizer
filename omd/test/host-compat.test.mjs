import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nativeHostFixture, nativeHosts, until } from './fixtures/native-host.mjs';

const enabled = process.env.OMD_NATIVE_MATRIX === '1';
const packagePath = process.env.OMD_INTENT_PACKAGE && resolve(process.env.OMD_INTENT_PACKAGE);
const baselinePackage = process.env.OMD_INTENT_BASELINE_PACKAGE && resolve(process.env.OMD_INTENT_BASELINE_PACKAGE);
const response = text => ({ delta: { role: 'assistant', content: text }, finish_reason: 'stop' });
const rawText = payload => payload.messages.filter(m => m.role === 'user').flatMap(m => typeof m.content === 'string' ? [m.content] : (m.content || []).filter(b => b.type === 'text').map(b => b.text)).join('\n');

test('stock Alpha rejects the original RC-only tarball without a version exemption', { timeout: 240000, skip: !enabled ? 'Set OMD_NATIVE_MATRIX=1 to run the native matrix' : false }, async t => {
  assert.ok(baselinePackage, 'Missing OMD_INTENT_BASELINE_PACKAGE');
  const f = await nativeHostFixture(t, nativeHosts[1], { install: false });
  let refusal;
  await assert.rejects(f.command(['plugin', '--profile', 'intent-native', 'add', 'file:' + baselinePackage]), error => { refusal = error.message; return /incompatible|compatib|peer|0\.2\.0-rc\.2/i.test(refusal); });
  const exemptions = await f.call('pluginManager/listVersionExemptions');
  assert.deepEqual(exemptions.exemptions, {});
  assert.equal((await f.request('/omd-intent/api/config')).status, 404);
  t.diagnostic(JSON.stringify({ baseline: 'rejected', refusal, ...f.evidence }));
});

for (const host of nativeHosts) test(`stock DSH ${host.version}: native intent, preserved attachment, restart and bundle lifecycle`, { timeout: 360000, skip: !enabled ? 'Set OMD_NATIVE_MATRIX=1 to run the native matrix' : false }, async t => {
  assert.ok(packagePath, 'Missing OMD_INTENT_PACKAGE');
  const interpreted = [], main = []; let held = false, release;
  const f = await nativeHostFixture(t, host, { packagePath, modelReply: async payload => {
    if (!JSON.stringify(payload.messages).includes('意图补全器')) { if (payload.tools?.length) main.push(payload); return response('原生宿主验收回答'); }
    interpreted.push(payload);
    const raw = rawText(payload), input = raw.split('【用户原话（逐字，供你引用；不要改写它）】\n')[1]?.split('\n\n【标识')[0];
    assert.ok(input, 'the interpretation request marks the verbatim input');
    if (held) await new Promise(resolve => { release = resolve; });
    return response(JSON.stringify({ ops: [{ op: 'add_item', item: { id: 'native-req', kind: 'user_requirement', text: '只调整用户指定的颜色，保留功能。', quote: input, scope: 'turn', sourceRefs: [{ kind: 'human', sessionId: raw.match(/sessionId=([^\s]+)/)?.[1], messageId: raw.match(/messageId=([^\s]+)/)?.[1] }] } }] }));
  } });
  t.after(() => release?.());
  const api = async (path, body) => {
    const r = await f.request('/omd-intent/api' + path, { headers: { 'Content-Type': 'application/json', 'x-omd-intent': '1' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await r.json(); assert.equal(r.status, 200, JSON.stringify(value)); return value;
  };
  const config = () => api('/config');
  const initial = await config(); assert.equal(initial.config.enabled, false); assert.equal(initial.runtime.hooks, 0);
  assert.deepEqual((await f.call('pluginManager/listVersionExemptions')).exemptions, {});
  const manifest = JSON.parse(await readFile(join(f.profileDir, 'package.json'), 'utf8'));
  const installed = JSON.parse(await readFile(join(f.profileDir, 'node_modules', 'omd-prompt-optimizer', 'package.json'), 'utf8'));
  const expected = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(installed.version, expected.version, 'the tarball matches the candidate source version');
  f.evidence.packageVersion = installed.version;
  assert.match(manifest.dependencies['omd-prompt-optimizer'], /^(?:file:|\/)/);
  assert.equal(Object.values(manifest.dependencies).some(value => String(value).startsWith('link:')), false);
  const registered = await f.rpc('workspace/create', { path: f.workspace });
  const { sessionId } = await f.rpc('session/create', { workspaceId: registered.workspace.workspaceId });
  await f.rpc('session/prompt', { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: '原生宿主验收会话' }] });
  await until(() => main.length > 0);
  await f.rpc('session/rename', { sessionId, title: '原生宿主验收会话' });
  let page = await f.open();
  const selectSession = async () => { await page.getByText('原生宿主验收会话', { exact: true }).first().click(); await page.locator('[data-composer-input]').waitFor(); };
  await selectSession();
  assert.equal(await page.evaluate(() => typeof window.__ModuleLoader__?.load), 'function');
  assert.ok(f.resources.some(resource => resource.status === 200 && resource.url.includes('omd-prompt-optimizer/client.js')), 'the native ModuleLoader fetched the packed client');
  assert.equal(await page.getByRole('button', { name: '需求理解选项', exact: true }).count(), 0);
  assert.equal(interpreted.length, 0);
  const baselineTools = main[0].tools;
  const settingsOpen = async () => { await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '需求理解', exact: true }).click(); };
  await settingsOpen(); await page.getByRole('switch', { name: '启用需求理解', exact: true }).click(); await until(async () => (await config()).config.enabled); await until(() => page.getByRole('switch', { name: '启用需求理解', exact: true }).isEnabled()); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '需求理解选项', exact: true }).waitFor();
  const panel = () => page.getByRole('dialog', { name: '需求理解', exact: true });
  const editor = () => page.locator('[data-composer-input]');
  const original = '只改颜色，保留 {{literal}}、全部功能和附件。';
  // Upload through the stock composer's actual input; verify what its native
  // model request receives after the plugin intercepts and resumes submission.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEUlEQVR4nGNgaPj/Hy8eGQoA1EefgTy4I8EAAAAASUVORK5CYII=', 'base64');
  await page.locator('input[type=file]').last().setInputFiles({ name: 'intent-native.png', mimeType: 'image/png', buffer: png });
  await page.locator('[data-composer-card] img').waitFor();
  const workBefore = main.length; await editor().fill(original); await editor().press('Enter');
  await panel().getByRole('button', { name: '采用并发送', exact: true }).waitFor();
  assert.equal(main.length, workBefore); assert.equal(await editor().innerText(), original);
  await panel().getByRole('button', { name: '采用并发送', exact: true }).click(); await until(() => main.length > workBefore);
  const reviewed = main.at(-1), lastUser = reviewed.messages.filter(m => m.role === 'user').findLast(m => Array.isArray(m.content) && m.content.some(b => b.type === 'text' && b.text === original));
  assert.ok(lastUser, 'verbatim user text reaches native model');
  assert.ok(lastUser.content.some(b => b.type === 'image_url' && b.image_url?.url === 'data:image/png;base64,' + png.toString('base64')), 'exact image bytes reach native model');
  assert.deepEqual(reviewed.tools, baselineTools, 'work model tools are unchanged');
  assert.ok(JSON.stringify(reviewed.messages).includes('只调整用户指定的颜色'), 'approved accompanying context reaches native model');
  await until(async () => await editor().innerText() === '');
  if (await panel().isVisible()) await panel().getByRole('button', { name: '关闭需求理解面板', exact: true }).click();
  await settingsOpen(); await page.getByLabel('优化权限', { exact: true }).selectOption('auto'); await until(async () => (await config()).config.permission === 'auto'); await until(() => page.getByLabel('优化权限', { exact: true }).isEnabled()); await page.keyboard.press('Escape');
  const autoInterpretBefore = interpreted.length, autoBefore = main.length; await editor().fill('自动发送仍保留 {{verbatim}} 原话'); await editor().press('Enter'); await until(() => main.length > autoBefore); assert.equal(interpreted.length, autoInterpretBefore + 1, 'auto uses the configured interpretation model');
  assert.ok(main.at(-1).messages.some(m => m.role === 'user' && (m.content === '自动发送仍保留 {{verbatim}} 原话' || Array.isArray(m.content) && m.content.some(b => b.type === 'text' && b.text === '自动发送仍保留 {{verbatim}} 原话'))));
  await until(async () => await editor().innerText() === '');
  if (await panel().isVisible()) await panel().getByRole('button', { name: '关闭需求理解面板', exact: true }).click();
  held = true; const cancelBefore = main.length; await editor().fill('取消时保留原话'); await editor().press('Enter'); await until(() => !!release); assert.ok(rawText(interpreted.at(-1)).includes('取消时保留原话'));
  await panel().getByRole('button', { name: '停止', exact: true }).click(); release(); release = null; held = false;
  await until(async () => (await config()).runtime.requests === 0); assert.equal(main.length, cancelBefore); assert.equal(await editor().innerText(), '取消时保留原话');
  if (await panel().isVisible()) await panel().getByRole('button', { name: '关闭需求理解面板', exact: true }).click();
  held = true; await editor().fill('关闭组件时保留原话'); await editor().press('Enter'); await until(() => !!release); assert.ok(rawText(interpreted.at(-1)).includes('关闭组件时保留原话'));
  await panel().getByRole('button', { name: '关闭需求理解面板', exact: true }).click(); await settingsOpen(); await page.getByRole('switch', { name: '启用需求理解', exact: true }).click(); release(); release = null; held = false;
  await until(async () => (await config()).runtime.hooks === 0); await page.keyboard.press('Escape');
  assert.equal(main.length, cancelBefore); assert.equal(await editor().innerText(), '关闭组件时保留原话');
  await until(async () => await page.getByRole('button', { name: '需求理解选项', exact: true }).count() === 0);
  const calls = interpreted.length; await editor().press('Enter'); await until(() => main.length > cancelBefore); assert.equal(interpreted.length, calls);
  // This stops and starts the actual CLI process and opens a fresh browser
  // context. A page reload alone cannot establish persisted host behavior.
  const saved = await config(); page = await f.restart(); await selectSession();
  const restarted = await config(); assert.equal(restarted.config.enabled, false); assert.equal(restarted.config.permission, 'auto'); assert.equal(restarted.revision, saved.revision);
  assert.equal(await page.getByRole('button', { name: '需求理解选项', exact: true }).count(), 0);
  assert.equal((await f.call('pluginManager/setBundleEnabled', { name: 'omd-prompt-optimizer', enabled: false })).application, 'applied');
  await until(async () => (await f.request('/omd-intent/api/config')).status === 404);
  await page.reload(); await selectSession(); await page.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '需求理解', exact: true }).count(), 0); await page.keyboard.press('Escape');
  assert.equal((await f.call('pluginManager/setBundleEnabled', { name: 'omd-prompt-optimizer', enabled: true })).application, 'applied');
  await until(async () => (await f.request('/omd-intent/api/config')).status === 200);
  assert.equal((await config()).config.enabled, false);
  assert.equal((await f.call('pluginManager/removeBundle', { name: 'omd-prompt-optimizer' })).application, 'applied');
  await until(async () => (await f.request('/omd-intent/api/config')).status === 404);
  // Exercise the native live install RPC too, with no override/accepted risk.
  assert.equal((await f.call('pluginManager/installBundle', { spec: 'file:' + packagePath, options: { enabled: true, requestId: crypto.randomUUID() } })).application, 'applied');
  await until(async () => (await f.request('/omd-intent/api/config')).status === 200);
  assert.deepEqual((await f.call('pluginManager/listVersionExemptions')).exemptions, {});
  assert.equal((await f.call('pluginManager/removeBundle', { name: 'omd-prompt-optimizer' })).application, 'applied');
  await until(async () => (await f.request('/omd-intent/api/config')).status === 404);
  await page.reload(); await selectSession(); await page.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '需求理解', exact: true }).count(), 0);
  assert.equal(await page.locator('style[data-plugin="omd-intent-assistant"]').count(), 0);
  assert.deepEqual(f.errors, []);
  t.diagnostic(JSON.stringify({ ...f.evidence, nativeModuleLoader: true, defaultDisabled: true, review: true, auto: true, verbatim: true, attachmentBytes: true, cancel: true, disableInFlight: true, processRestart: true, bundleDisableEnable: true, liveInstall: true, uninstall404: true, removedClientSlot: true, interpreterCalls: interpreted.length, workCalls: main.length }));
});
