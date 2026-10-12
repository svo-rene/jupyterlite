# jupyterlite-forgejo

A JupyterLite extension that signs in to a [Forgejo](https://forgejo.org) instance and syncs
repositories with the JupyterLite file browser. On this site it talks to
[git.inf7.eu](https://git.inf7.eu).

It adds a **Forgejo** panel (the cloud icon) to the left sidebar:

- **Mit … anmelden** opens a popup window, where you log in to Forgejo and authorize the app.
- **Repository holen …** fetches any repository you can write to into a folder of the file
  browser. The dialog suggests your own repositories and the ones you are a member of, but any
  `owner/name` can be typed in.
- **Hochladen …** commits every local change in that folder (new, changed and deleted files) to
  the branch, as one commit with a message you choose.
- **Aktualisieren** brings in changes made on Forgejo since the last sync.
- **Trennen** removes the link to the repository and leaves the files where they are.

The panel counts the local changes as you work. Nothing reaches Forgejo until you upload.

## How it works

There is no server: the site is static, so everything runs in the browser.

- **Sign-in** is the OAuth2 authorization code flow with PKCE, as a *public* client without a
  secret. Forgejo redirects the popup to [`callback.html`](callback.html), which the workflow
  publishes as `/forgejo-callback.html`. That page hands the code back to the JupyterLite tab.
  The access and refresh tokens are kept in the browser's `localStorage`, and expired access
  tokens are renewed with the refresh token.
- **Files** are copied into the browser storage like any other file. Notebooks and the Python
  kernel therefore see them as usual, `open("daten/werte.csv")` included, and they keep working
  offline.
- **Changes** are found by hashing. For every file the extension remembers the blob SHA on
  Forgejo and the git blob SHA of the local bytes from the last sync. A notebook that JupyterLite
  merely re-serialised does not count as changed. Notebooks are uploaded the way nbformat writes
  them (sorted keys, one-space indent), so commits from here and from Jupyter elsewhere diff
  cleanly.
- **Uploads** use the `POST /repos/{owner}/{repo}/contents` API, which writes several files in
  one commit. Every update carries the SHA it is based on. If someone changed the same file on
  Forgejo in the meantime, Forgejo refuses the upload and the panel asks you to update first.
- **Conflicts** come up when an update finds a file changed on both sides. Your version stays,
  and the Forgejo version is written next to it as `name (Forgejo).ext`. You merge by hand and
  delete the copy. The next upload then replaces the Forgejo version with yours. The copy itself
  is never uploaded.

Files larger than 50 MB are skipped. `.git` and `.ipynb_checkpoints` folders are never synced.

## Setting it up

Two things have to be done once on the Forgejo side. After that, the client ID goes into
[`overrides.json`](../overrides.json).

### 1. Create an OAuth2 application (any Forgejo user can do this)

On Forgejo, go to **Settings → Applications → Manage OAuth2 applications** and create an
application:

| Field | Value |
| --- | --- |
| Application name | `JupyterLite` |
| Redirect URIs | `https://jupyterlite.inf7.eu/forgejo-callback.html` and, for local testing, `http://localhost:8000/forgejo-callback.html` |
| Confidential client | **off**: the site cannot keep a secret, it uses PKCE instead |

Forgejo then shows a client ID and a client secret. Only the **client ID** is needed. It is not
secret and goes into [`overrides.json`](../overrides.json):

```json
"jupyterlite-forgejo:plugin": {
  "url": "https://git.inf7.eu",
  "clientId": "<client id>"
}
```

Until the client ID is set, the panel says that Forgejo is not set up yet.

### 2. Enable CORS on the Forgejo instance (the administrator does this)

The browser calls Forgejo from a different origin (`jupyterlite.inf7.eu` → `git.inf7.eu`), and
Forgejo only answers such calls when CORS is switched on. In Forgejo's `app.ini`:

```ini
[cors]
ENABLED      = true
ALLOW_DOMAIN = https://jupyterlite.inf7.eu
METHODS      = GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS
HEADERS      = Content-Type,User-Agent,Authorization
```

Then restart Forgejo. This allows cross-origin requests from that one site only, without cookies
(`ALLOW_CREDENTIALS` stays `false`), so it does not open up the Forgejo web interface. CORS
covers the API (`/api/v1/…`) and the OAuth2 token endpoint (`/login/oauth/access_token`). The
login page itself runs in the popup and needs no CORS.

If Forgejo sits behind a reverse proxy, the proxy has to pass `OPTIONS` requests and the
`Access-Control-*` response headers through unchanged.

To check, run this in the browser console on `https://jupyterlite.inf7.eu`:

```js
await fetch('https://git.inf7.eu/api/v1/version').then(r => r.json())
```

If CORS is set up, this returns the Forgejo version instead of a CORS error.

### Optional settings

These can also be set in `overrides.json`, or per user under *Settings → Settings Editor →
Forgejo*:

| Setting | Default | Meaning |
| --- | --- | --- |
| `url` | (empty) | Base URL of the Forgejo instance |
| `clientId` | (empty) | Client ID of the OAuth2 application |
| `scope` | (empty) | Requested scopes, space-separated. Empty means everything the account may do. Forgejo/Gitea versions with scoped OAuth2 tokens accept e.g. `write:repository read:user` |
| `redirectPath` | `forgejo-callback.html` | Callback page, relative to the site root |

## Security notes

- While you are signed in, the token in `localStorage` can act on your repositories.
- Any script running on `jupyterlite.inf7.eu` in the same browser can read that token. That
  includes JavaScript in notebook output once you trust the notebook. So only run notebooks you
  trust while you are signed in.
- **Abmelden** deletes the token. The authorization itself can be revoked on Forgejo under
  **Settings → Applications → Authorized OAuth2 applications**.

## Development

```bash
cd forgejo
npm ci
npm run build:prod          # writes labextensions/jupyterlite-forgejo
```

[`jupyter_lite_config.json`](../jupyter_lite_config.json) points `jupyter lite build` at
`forgejo/labextensions`. The build needs `jupyter-builder`, which comes with `jupyterlab` from
[`requirements.txt`](../requirements.txt).
