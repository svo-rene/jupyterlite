/**
 * OAuth2 authorization code flow with PKCE against Forgejo, run entirely in the
 * browser: the site is static, so the client is a public one without a secret.
 *
 * The login runs in a popup. Forgejo redirects it to a small static callback page,
 * which hands code and state back through postMessage and a BroadcastChannel (the
 * latter in case the popup lost its opener on the way).
 */

export const CALLBACK_CHANNEL = 'jupyterlite-forgejo-oauth';

const STORAGE_KEY = 'jupyterlite-forgejo:token';

/** Renew the access token this long before it actually expires. */
const EXPIRY_MARGIN_MS = 60 * 1000;

export interface IAuthConfig {
  url: string;
  clientId: string;
  scope: string;
  redirectUri: string;
}

interface IStoredToken {
  /** Forgejo base URL and client the token belongs to. */
  url: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface ICallbackMessage {
  type: 'forgejo-oauth';
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

/** Raised when no usable token is left and the user has to sign in again. */
export class LoginRequiredError extends Error {
  constructor() {
    super('Bitte melde dich bei Forgejo an.');
    this.name = 'LoginRequiredError';
  }
}

class TokenRejectedError extends Error {}

export class Auth {
  constructor(private _config: IAuthConfig) {}

  set config(config: IAuthConfig) {
    this._config = config;
  }

  get config(): IAuthConfig {
    return this._config;
  }

  get isConfigured(): boolean {
    return Boolean(this._config.url && this._config.clientId);
  }

  /** Whether a token for the configured instance is stored, possibly expired. */
  get hasToken(): boolean {
    return this._load() !== null;
  }

  /**
   * Run the login popup. Has to be called directly from a click handler: the
   * popup is opened before the first await, or the browser blocks it.
   *
   * A closed popup is not taken as a cancellation: once the popup has been on
   * Forgejo, a Cross-Origin-Opener-Policy there may make it look closed from here
   * while it is still open. Cancelling goes through `signal` instead.
   */
  async login(signal?: AbortSignal): Promise<void> {
    if (!this.isConfigured) {
      throw new Error('Forgejo ist nicht konfiguriert (Adresse oder Client-ID fehlt).');
    }
    const popup = window.open(
      'about:blank',
      'jupyterlite-forgejo-login',
      'popup,width=520,height=720'
    );
    if (!popup) {
      throw new Error('Das Anmeldefenster wurde blockiert. Bitte erlaube Pop-ups für diese Seite.');
    }

    try {
      const verifier = randomString(64);
      const state = randomString(32);
      const challenge = base64url(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
      );

      const authorize = new URL('login/oauth/authorize', withSlash(this._config.url));
      authorize.search = new URLSearchParams({
        client_id: this._config.clientId,
        redirect_uri: this._config.redirectUri,
        response_type: 'code',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...(this._config.scope ? { scope: this._config.scope } : {})
      }).toString();

      const result = waitForCallback(state, signal);
      popup.location.href = authorize.toString();
      const code = await result;

      const token = await this._tokenRequest({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: this._config.redirectUri
      });
      this._store(token);
    } finally {
      if (!popup.closed) {
        popup.close();
      }
    }
  }

  logout(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // nothing stored, nothing to remove
    }
  }

  /** A valid access token, renewed with the refresh token when needed. */
  async getToken(): Promise<string> {
    const stored = this._load();
    if (!stored) {
      throw new LoginRequiredError();
    }
    if (Date.now() < stored.expiresAt - EXPIRY_MARGIN_MS) {
      return stored.accessToken;
    }
    if (!stored.refreshToken) {
      this.logout();
      throw new LoginRequiredError();
    }
    let token: IStoredToken;
    try {
      token = await this._tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken
      });
    } catch (error) {
      // a network problem keeps the refresh token for the next try
      if (error instanceof TokenRejectedError) {
        this.logout();
        throw new LoginRequiredError();
      }
      throw error;
    }
    this._store(token);
    return token.accessToken;
  }

  private async _tokenRequest(params: Record<string, string>): Promise<IStoredToken> {
    // A form-encoded POST without custom headers is a "simple" request, so the
    // browser sends it without a CORS preflight.
    const response = await fetchOrExplain(
      this._config.url,
      new URL('login/oauth/access_token', withSlash(this._config.url)),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this._config.clientId, ...params })
      }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      throw new TokenRejectedError(
        `Forgejo hat kein Token ausgegeben: ${data.error_description || data.error || response.status}`
      );
    }
    return {
      url: this._config.url,
      clientId: this._config.clientId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? '',
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000
    };
  }

  private _load(): IStoredToken | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const token = JSON.parse(raw) as IStoredToken;
      if (token.url !== this._config.url || token.clientId !== this._config.clientId) {
        return null;
      }
      return token;
    } catch {
      return null;
    }
  }

  private _store(token: IStoredToken): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(token));
    } catch {
      // Storage blocked (private mode, say): the login then lasts for this page only.
    }
  }
}

/** Resolve with the authorization code once the callback page reports back. */
function waitForCallback(state: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const channel =
      typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CALLBACK_CHANNEL) : null;

    const cleanup = () => {
      window.removeEventListener('message', onWindowMessage);
      channel?.close();
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };

    const handle = (data: unknown) => {
      const message = data as ICallbackMessage;
      if (!message || message.type !== 'forgejo-oauth' || message.state !== state) {
        return;
      }
      cleanup();
      if (message.error || !message.code) {
        reject(
          new Error(
            message.error === 'access_denied'
              ? 'Die Anmeldung wurde abgelehnt.'
              : `Anmeldung fehlgeschlagen: ${message.errorDescription || message.error || 'kein Code erhalten'}`
          )
        );
      } else {
        resolve(message.code);
      }
    };

    const onWindowMessage = (event: MessageEvent) => {
      if (event.origin === window.location.origin) {
        handle(event.data);
      }
    };

    window.addEventListener('message', onWindowMessage);
    if (channel) {
      channel.onmessage = event => handle(event.data);
    }

    const onAbort = () => {
      cleanup();
      reject(new Error('Die Anmeldung wurde abgebrochen.'));
    };
    signal?.addEventListener('abort', onAbort);

    const timeout = setTimeout(
      () => {
        cleanup();
        reject(new Error('Die Anmeldung hat zu lange gedauert.'));
      },
      10 * 60 * 1000
    );
  });
}

/**
 * `fetch`, with the bare "Failed to fetch" a blocked cross-origin request produces
 * turned into a hint at the usual cause.
 */
export async function fetchOrExplain(
  base: string,
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        `Keine Verbindung zu ${new URL(base).host}. Entweder ist Forgejo nicht erreichbar, ` +
          'oder CORS ist dort für diese Seite nicht freigeschaltet.'
      );
    }
    throw error;
  }
}

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function randomString(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
