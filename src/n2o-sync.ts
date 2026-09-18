/**
 * The N2O Sync card: shows whether N2O Sync is in this vault, and installs it.
 *
 * The installer is N2O Sync Lite's (`n2o-lite/src/plugin/pro-installer.ts`),
 * ported, because Lite already ships it through the community store: nothing is
 * fetched until the person clicks Install, the disclosure Obsidian's developer
 * policies ask for sits next to the button, and nothing reaches disk until all
 * four release files pass verification. Keep the two in step: a change to what a
 * release contains, or to the pinned sql.js hash, has to land in both.
 */
import { App, Notice, requestUrl } from 'obsidian';
import { MARK_GEM, MARK_LETTERS, MARK_VIEWBOX } from './brand-paths';

/** The full edition's plugin id. */
const SYNC_ID = 'n2o';
/** N2O Sync Lite, from the store. It must be off before the full edition starts. */
const LITE_ID = 'notion-pull-lite';
const RELEASE_API_URL = 'https://api.github.com/repos/n2osync/n2o/releases/latest';
const SITE_URL = 'https://n2osync.com';
const REQUIRED_ASSETS = ['main.js', 'manifest.json', 'styles.css', 'sql-wasm.wasm'] as const;
type Asset = (typeof REQUIRED_ASSETS)[number];
const MIN_MAIN_JS_BYTES = 100 * 1024;
/** SHA-256 of sql.js 1.13.0's sql-wasm.wasm, the same pin N2O Sync Lite carries. */
const SQL_WASM_SHA256 = '0734155c83e493983d1f2ff5b09a4fab6e35a32e9449c7e4e545756439f62d73';

export const INSTALL_DISCLOSURE =
  'Installing downloads N2O Sync (about 2 MB) from github.com/n2osync/n2o and turns it on. ' +
  'Your notes and these settings are not touched.';

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

async function verify(files: Record<Asset, ArrayBuffer>): Promise<void> {
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
  const digest = await crypto.subtle.digest('SHA-256', files['sql-wasm.wasm']);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== SQL_WASM_SHA256) {
    throw new Error(
      `sql-wasm.wasm failed its integrity check, so nothing was installed. Try again, or install from ${SITE_URL}.`,
    );
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
    new Notice('N2O Sync is installed. Turn it on under Settings, Community plugins.', 10000);
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
  const files = await download(onProgress);
  onProgress('Checking the files...');
  await verify(files);
  onProgress('Installing...');
  const dir = `${app.vault.configDir}/plugins/${SYNC_ID}`;
  if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
  for (const name of REQUIRED_ASSETS) await app.vault.adapter.writeBinary(`${dir}/${name}`, files[name]);
  await plugins(app)?.loadManifests?.();
  onProgress('Turning it on...');
  await enableSync(app);
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

/**
 * One row of the box at the top of the tab: the mark and name on the left, the
 * state under it, the actions on the right. `redraw` re-renders the tab after
 * a state change.
 */
export function renderSyncRow(app: App, el: HTMLElement, redraw: () => void): void {
  const row = el.createDiv({ cls: 'n2o-ps-row' });
  const text = row.createDiv({ cls: 'n2o-ps-row-text' });
  const head = text.createDiv({ cls: 'n2o-ps-sync-head' });
  head.appendChild(brandMark());
  head.createSpan({ cls: 'n2o-ps-sync-name', text: 'Sync' });

  const status = syncStatus(app);
  const body = text.createDiv({ cls: 'n2o-ps-sync-body' });
  const actions = row.createDiv({ cls: 'n2o-ps-sync-actions' });
  const line = text.createDiv({ cls: 'n2o-ps-sync-line' });

  if (status === 'running') {
    body.setText('N2O Sync is running in this vault.');
    const open = actions.createEl('button', { text: 'Open N2O Sync settings' });
    open.onclick = () => (app as unknown as { setting?: { openTabById?: (id: string) => void } }).setting?.openTabById?.(SYNC_ID);
    return;
  }

  body.setText(
    'Keep your Notion pages and these notes in step, both ways, with N2O Sync. 14 days free, then Pro.',
  );
  const learn = actions.createEl('a', { text: 'Learn more', href: SITE_URL });
  learn.setAttr('target', '_blank');

  if (status === 'installed') {
    const on = actions.createEl('button', { cls: 'mod-cta', text: 'Turn on N2O Sync' });
    on.onclick = async () => {
      on.disabled = true;
      try {
        await enableSync(app);
      } catch (e) {
        line.setText(`Could not turn N2O Sync on: ${e instanceof Error ? e.message : String(e)}`);
        on.disabled = false;
        return;
      }
      redraw();
    };
    return;
  }

  const install = actions.createEl('button', { cls: 'mod-cta', text: 'Install N2O Sync Pro' });
  line.setText(INSTALL_DISCLOSURE);
  install.onclick = async () => {
    install.disabled = true;
    try {
      await installSync(app, (m) => line.setText(m));
    } catch (e) {
      line.setText(e instanceof Error ? e.message : String(e));
      line.addClass('mod-warning');
      install.disabled = false;
      install.setText('Try again');
      return;
    }
    redraw();
  };
}
