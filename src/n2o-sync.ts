/**
 * The N2O Sync row: shows whether N2O Sync is in this vault, and installs it.
 *
 * The installer is a port of N2O Sync Lite's (`n2o-lite/src/plugin/pro-installer.ts`):
 * nothing is fetched until the person clicks Install, and nothing reaches disk
 * until every release file passes verification. Keep the two in step; a unit
 * test in the n2o repo fails when REQUIRED_ASSETS here disagrees with
 * RELEASE_ASSETS in n2o/deploy.sh.
 */
import { App, Notice, requestUrl, type ButtonComponent, type Setting } from 'obsidian';
import { MARK_GEM, MARK_LETTERS, MARK_VIEWBOX } from './brand-paths';
import { SIGNED_RELEASE_FILES, signedReleaseProblem } from './release-signature';

/** The full edition's plugin id. */
const SYNC_ID = 'n2o';
/** N2O Sync Lite, from the store. It must be off before the full edition starts. */
const LITE_ID = 'notion-pull-lite';
const RELEASE_API_URL = 'https://api.github.com/repos/n2osync/n2o/releases/latest';
const SITE_URL = 'https://n2osync.com';
/**
 * Every file the install needs. Must equal RELEASE_ASSETS in n2o/deploy.sh.
 * release-signature.json is checked, never installed (#512).
 */
const REQUIRED_ASSETS = ['main.js', 'manifest.json', 'styles.css', 'release-signature.json'] as const;
type Asset = (typeof REQUIRED_ASSETS)[number];
const MIN_MAIN_JS_BYTES = 100 * 1024;
/**
 * N2O's installer floor (MIN_INSTALLER_VERSION in n2o/src/shared/constants.ts):
 * below it the installer has no node:sqlite and N2O refuses to start.
 */
const MIN_INSTALLER_VERSION = '1.9.10';

/** The Obsidian installer's version, or undefined when it cannot be read. */
function installerVersion(): string | undefined {
  try {
    const electron = (
      window as unknown as { electron?: { remote?: { app?: { getVersion?: () => string } } } }
    ).electron;
    return electron?.remote?.app?.getVersion?.();
  } catch {
    return undefined;
  }
}

/** True when dotted version `a` is below `b`. */
function isBelow(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/**
 * Refuse an installer N2O cannot start on, with the sentence N2O Sync Lite
 * shows. An unreadable version installs anyway: N2O then refuses itself.
 */
export function checkInstallerFloor(version: string | undefined = installerVersion()): void {
  if (!version || !isBelow(version, MIN_INSTALLER_VERSION)) return;
  throw new Error(
    `N2O needs the Obsidian installer ${MIN_INSTALLER_VERSION} or newer. This one is ${version}. ` +
      'Download the installer from https://obsidian.md/download, install it over this one (your vaults ' +
      'and settings stay), and restart Obsidian. Updating from inside Obsidian is not enough: it ' +
      'updates the app, never the installer. Nothing was installed.',
  );
}

interface PluginApi {
  enabledPlugins?: Set<string>;
  manifests?: Record<string, unknown>;
  loadManifests?: () => Promise<void>;
  enablePluginAndSave?: (id: string) => Promise<void>;
  disablePluginAndSave?: (id: string) => Promise<void>;
}
const plugins = (app: App): PluginApi | undefined =>
  (app as unknown as { plugins?: PluginApi }).plugins;

export type SyncStatus = 'running' | 'installed' | 'absent';

export function syncStatus(app: App): SyncStatus {
  const p = plugins(app);
  if (p?.enabledPlugins instanceof Set && p.enabledPlugins.has(SYNC_ID)) return 'running';
  if (p?.manifests && SYNC_ID in p.manifests) return 'installed';
  return 'absent';
}

async function download(onProgress: (m: string) => void): Promise<Record<Asset, ArrayBuffer>> {
  onProgress('Finding the latest release...');
  const release = await requestUrl({
    url: RELEASE_API_URL,
    headers: { Accept: 'application/vnd.github+json' },
    throw: false,
  });
  if (release.status !== 200) {
    throw new Error(
      `GitHub answered HTTP ${release.status} for the latest N2O Sync release. Check your connection and try again.`,
    );
  }
  const list = (release.json as { assets?: { name?: string; browser_download_url?: string }[] })
    .assets;
  const files = {} as Record<Asset, ArrayBuffer>;
  let i = 0;
  for (const name of REQUIRED_ASSETS) {
    const url = Array.isArray(list) ? list.find((a) => a.name === name)?.browser_download_url : undefined;
    if (!url) {
      throw new Error(
        `The latest N2O Sync release has no "${name}". That is a problem with the release, not your setup; try again later or install from ${SITE_URL}.`,
      );
    }
    onProgress(`Downloading ${name} (${++i} of ${REQUIRED_ASSETS.length})...`);
    const res = await requestUrl({ url, throw: false });
    if (res.status !== 200) {
      throw new Error(`Downloading ${name} failed (HTTP ${res.status}). Check your connection and try again.`);
    }
    files[name] = res.arrayBuffer;
  }
  return files;
}

function verify(files: Record<Asset, ArrayBuffer>): void {
  let id: unknown;
  try {
    id = (JSON.parse(new TextDecoder().decode(files['manifest.json'])) as { id?: unknown }).id;
  } catch {
    throw new Error('The downloaded manifest.json is not valid JSON. The download may be damaged; try again.');
  }
  if (id !== SYNC_ID) {
    throw new Error(`The downloaded manifest names plugin "${String(id)}", not N2O Sync. Nothing was installed.`);
  }
  if (files['main.js'].byteLength <= MIN_MAIN_JS_BYTES) {
    throw new Error('The downloaded main.js is too small to be N2O Sync. The download may be cut short; try again.');
  }
  if (files['styles.css'].byteLength === 0) {
    throw new Error('The downloaded styles.css is empty. The download may be damaged; try again.');
  }
}

/**
 * Turn N2O Sync on. Lite goes off FIRST when it is running, because both
 * editions register the same obsidian:// sign-in handler and must never load
 * side by side.
 */
export async function enableSync(app: App): Promise<void> {
  const p = plugins(app);
  if (!p?.enablePluginAndSave) {
    new Notice('N2O Sync is installed. Turn it on in the community plugins settings.', 10000);
    return;
  }
  const liteWasOn = p.enabledPlugins?.has(LITE_ID) === true;
  if (liteWasOn) await p.disablePluginAndSave?.(LITE_ID);
  await p.enablePluginAndSave(SYNC_ID);
  new Notice(
    liteWasOn ? 'N2O Sync is running. N2O Sync Lite has been turned off.' : 'N2O Sync is running.',
  );
}

/** Download, verify, write, then enable. Nothing is written if any check fails. */
export async function installSync(app: App, onProgress: (m: string) => void): Promise<void> {
  checkInstallerFloor();
  const files = await download(onProgress);
  onProgress('Checking the files...');
  verify(files);
  /* #512: signed by N2O, and not a byte changed since, or nothing is installed. */
  const problem = await signedReleaseProblem(files);
  if (problem) {
    throw new Error(`Not installing this N2O Sync release: ${problem}. Nothing was installed. Try again later, or install from ${SITE_URL}.`);
  }
  onProgress('Installing...');
  const dir = `${app.vault.configDir}/plugins/${SYNC_ID}`;
  if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
  for (const name of SIGNED_RELEASE_FILES) await app.vault.adapter.writeBinary(`${dir}/${name}`, files[name]);
  await leaveInstallMarker(app, dir);
  await plugins(app)?.loadManifests?.();
  onProgress('Turning it on...');
  await enableSync(app);
}

/**
 * Write install-source.json next to the files just installed. N2O Sync reads
 * it on its first connect and deletes it. A failure here never fails the install.
 */
async function leaveInstallMarker(app: App, dir: string): Promise<void> {
  try {
    await app.vault.adapter.write(
      `${dir}/install-source.json`,
      JSON.stringify({ source: 'n2o-paper-settings', at: new Date().toISOString() }, null, 2),
    );
  } catch {
    /* not attributed, which is no worse than before */
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
let gradientSeq = 0;

/** The real N2O mark: letters in the text colour, the gem O in the master gradient. */
export function brandMark(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', MARK_VIEWBOX);
  svg.setAttribute('class', 'n2o-ps-sync-mark');
  svg.setAttribute('aria-hidden', 'true');
  const id = `n2o-ps-gem-${++gradientSeq}`;
  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  // The master's gradient vector and stops, from Asset 1.svg.
  for (const [k, v] of [['id', id], ['gradientUnits', 'userSpaceOnUse'], ['x1', '1034.77'], ['y1', '659.84'], ['x2', '1545.83'], ['y2', '112.28']]) {
    grad.setAttribute(k, v);
  }
  for (const [offset, color] of [['0', '#a58ac0'], ['.55', '#785ba7'], ['1', '#603d98']]) {
    const stop = document.createElementNS(SVG_NS, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', color);
    grad.appendChild(stop);
  }
  defs.appendChild(grad);
  svg.appendChild(defs);
  const letters = document.createElementNS(SVG_NS, 'path');
  letters.setAttribute('d', MARK_LETTERS);
  letters.setAttribute('fill', 'currentColor');
  const gem = document.createElementNS(SVG_NS, 'path');
  gem.setAttribute('d', MARK_GEM);
  gem.setAttribute('fill', `url(#${id})`);
  svg.append(letters, gem);
  return svg;
}

/** The N2O Sync row in the settings tab. `redraw` re-renders the tab after a state change. */
export function renderSyncRow(app: App, setting: Setting, redraw: () => void): void {
  setting.nameEl.empty();
  setting.nameEl.appendChild(brandMark());
  setting.nameEl.createSpan({ text: ' Sync' });

  const status = syncStatus(app);
  if (status === 'running') {
    setting.setDesc('N2O Sync is running in this vault.');
    setting.addButton((b) => b.setButtonText('Open N2O Sync settings').onClick(() => {
      (app as unknown as { setting?: { openTabById?: (id: string) => void } }).setting?.openTabById?.(SYNC_ID);
    }));
    return;
  }

  setting.setDesc('Keep your Notion pages and these notes in step, both ways, with N2O Sync. Free for 14 days, then Pro.');
  setting.controlEl.createEl('a', { cls: 'n2o-ps-learn', text: 'Learn more', href: SITE_URL, attr: { target: '_blank' } });

  if (status === 'installed') {
    setting.addButton((b) => b.setButtonText('Turn on N2O Sync').onClick(async () => {
      b.setDisabled(true);
      try {
        await enableSync(app);
      } catch (e) {
        setting.setDesc(`Could not turn N2O Sync on: ${e instanceof Error ? e.message : String(e)}`);
        b.setDisabled(false);
        return;
      }
      redraw();
    }));
    return;
  }

  setting.addButton((b) => b.setButtonText('Install N2O Sync Pro').onClick(() => void install(app, setting, b, redraw)));
}

async function install(app: App, setting: Setting, b: ButtonComponent, redraw: () => void): Promise<void> {
  b.setDisabled(true);
  try {
    await installSync(app, (m) => { setting.setDesc(m); });
  } catch (e) {
    setting.setDesc(e instanceof Error ? e.message : String(e));
    b.setDisabled(false).setButtonText('Try again');
    return;
  }
  redraw();
}
