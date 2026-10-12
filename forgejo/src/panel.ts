/**
 * The sidebar panel: sign-in state, linked repositories and their buttons.
 */

import { Dialog, showDialog, showErrorMessage } from '@jupyterlab/apputils';
import { Contents } from '@jupyterlab/services';
import { Widget } from '@lumino/widgets';

import { IRepo, IUser, ForgejoApi } from './api';
import { Auth, LoginRequiredError } from './auth';
import { ConflictError, IClone, IPullResult, Sync } from './sync';

export interface IPanelOptions {
  auth: Auth;
  api: ForgejoApi;
  sync: Sync;
  contents: Contents.IManager;
  openFolder: (folder: string) => void;
}

export class ForgejoPanel extends Widget {
  constructor(private _options: IPanelOptions) {
    super();
    this.addClass('jp-ForgejoPanel');
    this.title.caption = 'Forgejo';
    _options.contents.fileChanged.connect(this._scheduleStatus, this);
    void this.refresh();
  }

  dispose(): void {
    this._options.contents.fileChanged.disconnect(this._scheduleStatus, this);
    super.dispose();
  }

  /** Re-read the sign-in state and redraw. */
  async refresh(): Promise<void> {
    const { auth, api } = this._options;
    this._user = null;
    if (auth.isConfigured && auth.hasToken) {
      try {
        this._user = await api.user();
      } catch (error) {
        if (!(error instanceof LoginRequiredError)) {
          this._message = `Forgejo ist nicht erreichbar: ${errorText(error)}`;
        }
      }
    }
    this._render();
  }

  protected onAfterShow(): void {
    void this._updateStatus();
  }

  private _render(): void {
    const { auth } = this._options;
    const node = this.node;
    node.replaceChildren();

    node.append(el('h2', { className: 'jp-ForgejoPanel-title' }, 'Forgejo'));

    if (!auth.isConfigured) {
      const missing = auth.config.url
        ? 'die OAuth2-Client-ID fehlt'
        : 'Adresse und OAuth2-Client-ID fehlen';
      node.append(
        el(
          'p',
          {},
          `Die Anmeldung bei Forgejo ist auf dieser Seite noch nicht eingerichtet: ${missing} in den Einstellungen.`
        )
      );
      return;
    }

    const host = new URL(auth.config.url).host;

    if (!this._user) {
      node.append(
        el(
          'p',
          {},
          `Melde dich bei ${host} an, um Notebooks in deinen Repositories zu speichern ` +
            'und von dort zu laden.'
        )
      );
      if (this._loginAbort) {
        node.append(
          el('p', { className: 'jp-ForgejoPanel-status' }, 'Anmeldung läuft im Pop-up-Fenster …'),
          button('Abbrechen', () => this._loginAbort?.abort())
        );
      } else {
        node.append(button(`Mit ${host} anmelden`, () => this._login(), true));
      }
      this._renderMessage();
      return;
    }

    node.append(
      el(
        'div',
        { className: 'jp-ForgejoPanel-user' },
        el('span', {}, `Angemeldet als ${this._user.login}`),
        button('Abmelden', () => this._logout())
      ),
      button('Repository holen …', () => this._clone(), true)
    );

    const clones = this._options.sync.clones();
    if (clones.length === 0) {
      node.append(
        el(
          'p',
          { className: 'jp-ForgejoPanel-hint' },
          'Noch kein Repository verbunden. Ein geholtes Repository erscheint als Ordner ' +
            'in der Dateiliste; „Hochladen“ speichert deine Änderungen als Commit auf Forgejo.'
        )
      );
    }
    for (const clone of clones.sort((a, b) => a.folder.localeCompare(b.folder))) {
      node.append(this._renderClone(clone));
    }
    this._renderMessage();
  }

  private _renderClone(clone: IClone): HTMLElement {
    const status = this._status.get(clone.folder);
    const busy = this._busy.has(clone.folder);
    const repoUrl = `${this._options.auth.config.url.replace(/\/+$/, '')}/${clone.repo}`;

    const card = el(
      'div',
      { className: 'jp-ForgejoPanel-clone' },
      el(
        'div',
        { className: 'jp-ForgejoPanel-repo' },
        el('a', { href: repoUrl, target: '_blank', rel: 'noopener' }, clone.repo),
        el('span', { className: 'jp-ForgejoPanel-branch' }, ` · ${clone.branch}`)
      ),
      el(
        'div',
        {},
        'Ordner: ',
        el(
          'a',
          {
            href: '#',
            onclick: (e: Event) => (e.preventDefault(), this._options.openFolder(clone.folder))
          },
          clone.folder
        )
      )
    );

    let statusText = 'Prüfe Änderungen …';
    if (busy) {
      statusText = this._progress.get(clone.folder) ?? 'Arbeite …';
    } else if (status instanceof Error) {
      statusText = errorText(status);
    } else if (status) {
      statusText =
        status.length === 0
          ? 'Keine lokalen Änderungen'
          : `${status.length} lokale Änderung${status.length === 1 ? '' : 'en'}`;
    }
    card.append(el('div', { className: 'jp-ForgejoPanel-status' }, statusText));

    if (clone.conflictCopies.length > 0) {
      card.append(
        el(
          'div',
          { className: 'jp-ForgejoPanel-warning' },
          'Konflikt: Vergleiche ' +
            clone.conflictCopies.map(copy => `„${copy}“`).join(', ') +
            ' mit deiner Version, übernimm, was du brauchst, und lösche die Kopie. ' +
            'Beim Hochladen gewinnt deine Version.'
        )
      );
    }

    const actions = el(
      'div',
      { className: 'jp-ForgejoPanel-actions' },
      button('Aktualisieren', () => this._pull(clone)),
      button('Hochladen …', () => this._push(clone), true),
      button('Trennen', () => this._unlink(clone))
    );
    actions.querySelectorAll('button').forEach(b => (b.disabled = busy));
    card.append(actions);
    return card;
  }

  private _renderMessage(): void {
    if (this._message) {
      this.node.append(el('p', { className: 'jp-ForgejoPanel-message' }, this._message));
    }
  }

  private _login(): void {
    const abort = new AbortController();
    this._loginAbort = abort;
    this._message = '';
    // login() opens the popup synchronously, inside this click
    const login = this._options.auth.login(abort.signal);
    this._render();
    login
      .then(() => this.refresh())
      .catch(error => {
        this._message = errorText(error);
      })
      .finally(() => {
        this._loginAbort = null;
        this._render();
        void this._updateStatus();
      });
  }

  private _logout(): void {
    this._options.auth.logout();
    this._user = null;
    this._message = '';
    this._render();
  }

  private async _clone(): Promise<void> {
    const body = new CloneForm(this._options.api, this._user!);
    const result = await showDialog({
      title: 'Repository holen',
      body,
      buttons: [Dialog.cancelButton({ label: 'Abbrechen' }), Dialog.okButton({ label: 'Holen' })],
      focusNodeSelector: 'input'
    });
    if (!result.button.accept || !result.value) {
      return;
    }
    const { repo, branch, folder } = result.value;
    await this._run(folder, async progress => {
      const info = await this._options.api.repo(repo);
      const pulled = await this._options.sync.create(
        info.full_name,
        branch || info.default_branch,
        folder,
        progress
      );
      await reportPull(pulled, true);
      this._options.openFolder(folder);
    });
  }

  private async _pull(clone: IClone): Promise<void> {
    await this._run(clone.folder, async progress => {
      const pulled = await this._options.sync.pull(clone, progress);
      await reportPull(pulled, false);
    });
  }

  private async _push(clone: IClone): Promise<void> {
    let changes;
    try {
      changes = await this._options.sync.changes(clone);
    } catch (error) {
      await this._handleError(error);
      return;
    }
    if (changes.length === 0) {
      await showDialog({
        title: 'Hochladen',
        body: 'Es gibt keine lokalen Änderungen.',
        buttons: [Dialog.okButton({ label: 'OK' })]
      });
      return;
    }
    const result = await showDialog({
      title: `Nach ${clone.repo} hochladen`,
      body: new CommitForm(changes),
      buttons: [
        Dialog.cancelButton({ label: 'Abbrechen' }),
        Dialog.okButton({ label: 'Hochladen' })
      ],
      focusNodeSelector: 'input'
    });
    if (!result.button.accept) {
      return;
    }
    const message = result.value || 'Änderungen aus JupyterLite';
    await this._run(clone.folder, async progress => {
      await this._options.sync.push(clone, message, progress);
    });
  }

  private async _unlink(clone: IClone): Promise<void> {
    const result = await showDialog({
      title: 'Verbindung trennen',
      body:
        `Der Ordner „${clone.folder}“ wird nicht mehr mit ${clone.repo} abgeglichen. ` +
        'Die Dateien bleiben im Browser erhalten, auf Forgejo ändert sich nichts.',
      buttons: [
        Dialog.cancelButton({ label: 'Abbrechen' }),
        Dialog.warnButton({ label: 'Trennen' })
      ]
    });
    if (result.button.accept) {
      this._options.sync.forget(clone.folder);
      this._status.delete(clone.folder);
      this._render();
    }
  }

  /** Run a long operation for one clone, with progress shown on its card. */
  private async _run(
    folder: string,
    task: (progress: (message: string) => void) => Promise<void>
  ): Promise<void> {
    this._busy.add(folder);
    this._message = '';
    this._render();
    try {
      await task(message => {
        this._progress.set(folder, message);
        this._render();
      });
    } catch (error) {
      await this._handleError(error);
    } finally {
      this._busy.delete(folder);
      this._progress.delete(folder);
      this._render();
      void this._updateStatus();
    }
  }

  private async _handleError(error: unknown): Promise<void> {
    if (error instanceof LoginRequiredError) {
      this._user = null;
      this._message = 'Die Anmeldung ist abgelaufen. Bitte melde dich erneut an.';
      this._render();
      return;
    }
    await showErrorMessage(
      error instanceof ConflictError ? 'Konflikt' : 'Forgejo',
      errorText(error)
    );
  }

  private _scheduleStatus(): void {
    if (!this.isVisible) {
      return;
    }
    clearTimeout(this._statusTimer);
    this._statusTimer = window.setTimeout(() => void this._updateStatus(), 1000);
  }

  private async _updateStatus(): Promise<void> {
    if (!this._user) {
      return;
    }
    for (const clone of this._options.sync.clones()) {
      if (this._busy.has(clone.folder)) {
        continue;
      }
      try {
        this._status.set(clone.folder, await this._options.sync.changes(clone));
      } catch (error) {
        this._status.set(clone.folder, error as Error);
      }
    }
    this._render();
  }

  private _user: IUser | null = null;
  private _message = '';
  private _loginAbort: AbortController | null = null;
  private _status = new Map<string, unknown[] | Error>();
  private _busy = new Set<string>();
  private _progress = new Map<string, string>();
  private _statusTimer = 0;
}

/** Dialog body for choosing repository, branch and folder. */
class CloneForm
  extends Widget
  implements
    Dialog.IBodyWidget<{
      repo: string;
      branch: string;
      folder: string;
    }>
{
  constructor(
    private _api: ForgejoApi,
    private _user: IUser
  ) {
    super();
    this.addClass('jp-ForgejoPanel-form');
    const listId = `jp-ForgejoPanel-repos-${Math.random().toString(36).slice(2)}`;
    this._repo = el('input', {
      type: 'text',
      placeholder: 'besitzer/repository',
      autocomplete: 'off'
    }) as HTMLInputElement;
    this._repo.setAttribute('list', listId);
    this._list = el('datalist', { id: listId }) as HTMLDataListElement;
    this._branch = el('input', {
      type: 'text',
      placeholder: 'Standard-Branch'
    }) as HTMLInputElement;
    this._folder = el('input', { type: 'text', placeholder: 'Ordnername' }) as HTMLInputElement;

    this.node.append(
      el('label', {}, 'Repository', this._repo, this._list),
      el('label', {}, 'Branch', this._branch),
      el('label', {}, 'Ordner in der Dateiliste', this._folder),
      el(
        'p',
        { className: 'jp-ForgejoPanel-hint' },
        'Du kannst jedes Repository wählen, in das du schreiben darfst. ' +
          'Die Liste zeigt deine eigenen und die, in denen du Mitglied bist.'
      )
    );

    this._repo.addEventListener('input', () => {
      this._fillFromRepo();
      clearTimeout(this._timer);
      this._timer = window.setTimeout(() => void this._search(), 250);
    });
    this._folder.addEventListener('input', () => (this._folderEdited = true));
    void this._search();
  }

  getValue() {
    return {
      repo: this._repo.value.trim().replace(/^\/+|\/+$/g, ''),
      branch: this._branch.value.trim(),
      folder: this._folder.value.trim() || this._repo.value.split('/').pop()!.trim()
    };
  }

  private async _search(): Promise<void> {
    const query = this._repo.value.trim();
    try {
      const repos = await this._api.searchRepos(this._user.id, query.split('/').pop() ?? '');
      for (const repo of repos) {
        this._known.set(repo.full_name, repo);
      }
      this._list.replaceChildren(...repos.map(repo => el('option', { value: repo.full_name })));
      this._fillFromRepo();
    } catch {
      // the list is only a convenience; typing owner/name works without it
    }
  }

  /** Pre-fill branch and folder once the input names a known repository. */
  private _fillFromRepo(): void {
    const repo = this._known.get(this._repo.value.trim());
    if (!repo) {
      return;
    }
    this._branch.placeholder = repo.default_branch;
    if (!this._folderEdited) {
      this._folder.value = repo.name;
    }
  }

  private _repo: HTMLInputElement;
  private _list: HTMLDataListElement;
  private _branch: HTMLInputElement;
  private _folder: HTMLInputElement;
  private _known = new Map<string, IRepo>();
  private _folderEdited = false;
  private _timer = 0;
}

/** Dialog body listing the changes and asking for a commit message. */
class CommitForm extends Widget implements Dialog.IBodyWidget<string> {
  constructor(changes: { path: string; operation: string }[]) {
    super();
    this.addClass('jp-ForgejoPanel-form');
    const labels: Record<string, string> = {
      create: 'neu',
      update: 'geändert',
      delete: 'gelöscht'
    };
    this._message = el('input', {
      type: 'text',
      placeholder: 'Änderungen aus JupyterLite'
    }) as HTMLInputElement;
    this.node.append(
      el(
        'ul',
        { className: 'jp-ForgejoPanel-changes' },
        ...changes.map(change =>
          el(
            'li',
            {},
            el('span', { className: 'jp-ForgejoPanel-op' }, labels[change.operation]),
            change.path
          )
        )
      ),
      el('label', {}, 'Commit-Nachricht', this._message)
    );
  }

  getValue(): string {
    return this._message.value.trim();
  }

  private _message: HTMLInputElement;
}

async function reportPull(result: IPullResult, initial: boolean): Promise<void> {
  const lines: string[] = [];
  if (result.conflicts.length > 0) {
    lines.push(
      'Diese Dateien wurden hier und auf Forgejo geändert. Deine Version bleibt, ' +
        'die Version von Forgejo liegt daneben:',
      ...result.conflicts.map(c => `  ${c.path} → ${c.copy}`)
    );
  }
  if (result.keptDeleted.length > 0) {
    lines.push(
      'Auf Forgejo gelöscht, hier aber geändert (bleiben erhalten und werden beim Hochladen wieder angelegt):',
      ...result.keptDeleted.map(path => `  ${path}`)
    );
  }
  if (result.skipped.length > 0) {
    lines.push('Zu groß, nicht geladen:', ...result.skipped.map(path => `  ${path}`));
  }
  if (lines.length === 0) {
    return;
  }
  await showDialog({
    title: initial ? 'Repository geholt' : 'Aktualisiert',
    body: new Widget({
      node: el('pre', { className: 'jp-ForgejoPanel-report' }, lines.join('\n'))
    }),
    buttons: [Dialog.okButton({ label: 'OK' })]
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const node = el(
    'button',
    {
      className: `jp-Button jp-mod-styled ${primary ? 'jp-mod-accept' : 'jp-mod-reject'}`,
      type: 'button'
    },
    label
  ) as HTMLButtonElement;
  node.addEventListener('click', onClick);
  return node;
}

function el(
  tag: string,
  props: Record<string, unknown> = {},
  ...children: (Node | string)[]
): HTMLElement {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}
