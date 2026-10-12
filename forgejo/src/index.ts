import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { PageConfig } from '@jupyterlab/coreutils';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { LabIcon } from '@jupyterlab/ui-components';

import { ForgejoApi } from './api';
import { Auth, IAuthConfig } from './auth';
import { ForgejoPanel } from './panel';
import { Sync } from './sync';

const PLUGIN_ID = 'jupyterlite-forgejo:plugin';

// a cloud with up and down arrows: sync with a remote place
const forgejoIcon = new LabIcon({
  name: 'jupyterlite-forgejo:icon',
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">
  <path class="jp-icon3" fill="#616161" d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95A5.469 5.469 0 0 1 12 6c2.62 0 4.88 1.86 5.39 4.43l.3 1.5 1.53.11A2.98 2.98 0 0 1 22 15c0 1.65-1.35 3-3 3zM9.5 11 12 8.5l2.5 2.5H13v3h-2v-3H9.5zm5 3.5L12 17l-2.5-2.5H11v-.5h2v.5h1.5z"/>
</svg>`
});

function readConfig(settings: ISettingRegistry.ISettings): IAuthConfig {
  const get = (key: string) => String(settings.composite[key] ?? '').trim();
  // the callback page sits at the root of the site, next to /lab and /notebooks
  const root = new URL(PageConfig.getBaseUrl(), window.location.href);
  return {
    url: get('url').replace(/\/+$/, ''),
    clientId: get('clientId'),
    scope: get('scope'),
    redirectUri: new URL(get('redirectPath') || 'forgejo-callback.html', root).toString()
  };
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Sign in to Forgejo and sync repositories with the file browser.',
  autoStart: true,
  requires: [ISettingRegistry],
  activate: async (app: JupyterFrontEnd, settingRegistry: ISettingRegistry) => {
    const settings = await settingRegistry.load(PLUGIN_ID);
    const auth = new Auth(readConfig(settings));
    const api = new ForgejoApi(auth);
    const contents = app.serviceManager.contents;
    const sync = new Sync(api, contents, () => auth.config.url);

    const panel = new ForgejoPanel({
      auth,
      api,
      sync,
      contents,
      openFolder: folder => {
        void app.commands.execute('filebrowser:go-to-path', { path: folder });
      }
    });
    panel.id = 'jupyterlite-forgejo';
    panel.title.icon = forgejoIcon;

    settings.changed.connect(() => {
      auth.config = readConfig(settings);
      void panel.refresh();
    });

    // JupyterLab and the Notebook app both have a left area; the REPL has none
    try {
      app.shell.add(panel, 'left', { rank: 150 });
    } catch {
      // a shell without sidebars
    }
  }
};

export default plugin;
