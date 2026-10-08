# OMD Prompt Optimizer · Intent Assistant 0.3.0

**An independent, optional OMD UI edition. It is not installed by default and remains disabled after installation.**

This edition uses the interpretation, validation and compilation engine from [WestFox-AwA/dsh-prompt-optimizer](https://github.com/WestFox-AwA/dsh-prompt-optimizer) 0.7.4, by 啃轮胎的西狐 (WestFox-AwA), under the [BSD-3-Clause license](LICENSE). It is not an official upstream release. The fixed upstream source commit is recorded in `omd/UPSTREAM.json` and included in the package.

[中文使用说明](README.md) · [Detailed behavior and validation scope](omd/README.md)

## Install and enable

Version **0.3.0** supports DSH **0.2.0-rc.2** and **0.2.1-alpha.1**. DSH 0.1.7-rc.2 users can use the historical [0.1.0 release](https://github.com/gulagala001/omd-prompt-optimizer/releases/tag/v0.1.0).

Install manually from **OMD → Settings → Recommended plugins → 需求理解 · OMD UI 增强版**, or download [omd-prompt-optimizer-0.3.0.tgz](https://github.com/gulagala001/omd-prompt-optimizer/releases/download/v0.3.0/omd-prompt-optimizer-0.3.0.tgz) from the [0.3.0 release](https://github.com/gulagala001/omd-prompt-optimizer/releases/tag/v0.3.0). Check its SHA-256 against `omd-intent-SHA256SUMS-0.3.0.txt` on the same release page.

```sh
dsh plugin --profile YOUR_PROFILE add /path/to/omd-prompt-optimizer-0.3.0.tgz
```

Reload or restart when prompted, then enable **Settings → 需求理解 → 启用需求理解**. Do not install the repository root or `po06/` as this edition. The distribution is built from `omd/`.

## Behavior

The assistant interprets the current request before sending. You can review or edit the accompanying interpretation, stop it, skip it, or select automatic delivery. Your original text, attachments and native submit metadata pass through DSH's native send entry. The interpretation is a separate accompanying message bound to the current input. It remains in normal session history but is not attached again to later inputs.

Settings include light/standard/heavy interpretation, review/automatic delivery, session or chosen model, recent 0–10 rounds or readable history, and optional read-only project files. Changing the draft, attachments or settings prevents stale results from sending. Configuration is isolated per DSH_HOME/profile in `omd-intent-assistant.json`.

Disabled mode removes sending/context hooks, cancels outstanding requests and rejects late results. It retains installation files, configuration and the settings/management entry. Disabling does not undo messages already sent, provider costs or previous answers. No additional Bash runtime or work-model tools are included. Avoid enabling both the upstream send interceptor and this assistant, or two automatic optimizers at once.

## Data and validation

There is no author telemetry. When enabled, your text, selected history and permitted file contents are sent to your configured model provider. History budgets are 12,000 characters for recent rounds and 60,000 for readable history; truncation is disclosed. Extra model calls add latency and cost. Missing provider token usage is displayed as “—”.

Offline tests cover disabled lifecycle, cancellation, isolation, verbatim text and attachments, command bypass, submit metadata, stale-input protection, wrapper coexistence and upstream interpretation/validation. Native macOS tests install actual tarballs into isolated stock DSH 0.2.0-rc.2 and 0.2.1-alpha.1 profiles without version exemptions or source links, covering native loading, review/automatic sending, exact image bytes, restart, enable/disable, reinstall and uninstall. OMD integration tests cover read-only tools, light/dark themes and narrow layouts. Model responses are local fixtures. Windows/Linux native desktop behavior and real-provider effectiveness remain unverified.

## Build

```sh
cd omd
npm ci
npm run build
npm test
npm run test:upstream
npm pack --ignore-scripts
```

Native test configuration and exact scope are documented in [omd/README.md](omd/README.md). Source and binary distributions retain the upstream BSD-3-Clause license and attribution.
