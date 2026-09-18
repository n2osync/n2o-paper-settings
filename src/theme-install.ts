/**
 * Getting N2O Paper itself into the vault.
 *
 * This plugin is useless without the theme: it renders the controls the theme
 * declares, so a vault with the plugin and no theme shows an empty tab. So the
 * theme is fetched on first load, and the card offers the same thing by hand
 * whenever the theme is missing or is installed but not selected.
 *
 * Two ways in, in this order:
 *   1. app.customCss.installTheme, Obsidian's own installer, which is what the
 *      theme browser uses. It refuses any theme the app's community list does
 *      not carry, so it does nothing until the listing is mirrored.
 *   2. The release on GitHub: theme.css and manifest.json written into
 *      <config>/themes/N2O Paper/. Nothing lands on disk unless both files
 *      arrive and the manifest parses and names this theme.
 */
import { App, Notice, requestUrl } from 'obsidian';

export const THEME_NAME = 'N2O Paper';
const THEME_REPO = 'n2osync/n2o-paper';
const RELEASE_API_URL = `https://api.github.com/repos/${THEME_REPO}/releases/latest`;
const REQUIRED = ['theme.css', 'manifest.json'] as const;
type Asset = (typeof REQUIRED)[number];
const MIN_THEME_CSS_BYTES = 50 * 1024;

interface CustomCss {
  theme?: string;
  themes?: Record<string, unknown>;
  isThemeInstalled?: (name: string) => boolean;
  installTheme?: (manifest: { name: string; repo: string }, version: string) => Promise<void>;
  setTheme?: (name: string) => void;
  loadTheme?: (name: string) => void;
  readThemes?: () => Promise<void>;
}
const css = (app: App): CustomCss | undefined =>
  (app as unknown as { customCss?: CustomCss }).customCss;

export type ThemeStatus = 'active' | 'installed' | 'absent';

export function themeStatus(app: App): ThemeStatus {
  const c = css(app);
  if (c?.theme === THEME_NAME) return 'active';
  const installed = c?.isThemeInstalled?.(THEME_NAME) ?? (c?.themes ? THEME_NAME in c.themes : false);
  return installed ? 'installed' : 'absent';
}

/** Select the theme. Obsidian writes the choice to appearance.json itself. */
export function selectTheme(app: App): void {
  const c = css(app);
  if (!c?.setTheme) {
    new Notice(`Choose ${THEME_NAME} under Settings, Appearance, Themes.`, 8000);
    return;
  }
  c.setTheme(THEME_NAME);
  new Notice(`${THEME_NAME} is on.`);
}

async function fromRelease(onProgress: (m: string) => void): Promise<Record<Asset, ArrayBuffer>> {
  onProgress('Finding the latest release...');
  const release = await requestUrl({
    url: RELEASE_API_URL,
    headers: { Accept: 'application/vnd.github+json' },
    throw: false,
  });
  if (release.status !== 200) {
    throw new Error(
      `GitHub answered HTTP ${release.status} for the latest ${THEME_NAME} release. Check your connection and try again.`,
    );
  }
  const list = (release.json as { assets?: { name?: string; browser_download_url?: string }[] })
    .assets;
  const files = {} as Record<Asset, ArrayBuffer>;
  for (const name of REQUIRED) {
    const url = Array.isArray(list)
      ? list.find((a) => a.name === name)?.browser_download_url
      : undefined;
    if (!url) {
      throw new Error(
        `The latest ${THEME_NAME} release has no "${name}". That is a problem with the release, not your setup; try again later.`,
      );
    }
    onProgress(`Downloading ${name}...`);
    const res = await requestUrl({ url, throw: false });
    if (res.status !== 200) {
      throw new Error(`Downloading ${name} failed with HTTP ${res.status}. Nothing was installed.`);
    }
    files[name] = res.arrayBuffer;
  }
  return files;
}

/** Refuse anything that is not the theme, so a bad release cannot land on disk. */
function verify(files: Record<Asset, ArrayBuffer>): void {
  if (files['theme.css'].byteLength < MIN_THEME_CSS_BYTES) {
    throw new Error('The downloaded theme.css is too small to be the theme, so nothing was installed.');
  }
  let manifest: { name?: string; version?: string };
  try {
    manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as typeof manifest;
  } catch {
    throw new Error('The downloaded manifest.json is not valid JSON, so nothing was installed.');
  }
  if (manifest.name !== THEME_NAME) {
    throw new Error(
      `The downloaded manifest names "${manifest.name ?? 'nothing'}" rather than ${THEME_NAME}, so nothing was installed.`,
    );
  }
}

/**
 * Install the theme and select it.
 *
 * Obsidian's own installer goes first and is a no-op when the app does not know
 * the theme yet, so a failure there is not an error: the release path follows.
 */
export async function installTheme(app: App, onProgress: (m: string) => void): Promise<void> {
  const c = css(app);
  if (c?.installTheme) {
    onProgress('Asking Obsidian to install it...');
    try {
      await c.installTheme({ name: THEME_NAME, repo: THEME_REPO }, '');
      await c.readThemes?.();
    } catch {
      /* not in the app's community list yet; the release path below handles it */
    }
    if (themeStatus(app) !== 'absent') {
      selectTheme(app);
      return;
    }
  }

  const files = await fromRelease(onProgress);
  onProgress('Checking the files...');
  verify(files);
  onProgress('Installing...');
  const dir = `${app.vault.configDir}/themes/${THEME_NAME}`;
  if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
  for (const name of REQUIRED) await app.vault.adapter.writeBinary(`${dir}/${name}`, files[name]);
  await c?.readThemes?.();
  onProgress('Turning it on...');
  selectTheme(app);
}
