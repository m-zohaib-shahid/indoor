import { createClient } from '@insforge/sdk';

const DEFAULT_INSFORGE_URL = 'https://ypbur365.us-east.insforge.app';

const rawBaseUrl =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_INSFORGE_URL) ||
  DEFAULT_INSFORGE_URL;
const baseUrl = String(rawBaseUrl).trim().replace(/\/+$/, '') || DEFAULT_INSFORGE_URL;

const rawAnonKey =
  typeof import.meta !== 'undefined' ? import.meta.env?.VITE_INSFORGE_ANON_KEY : undefined;
const trimmedAnonKey = typeof rawAnonKey === 'string' ? rawAnonKey.trim() : '';
const anonKey =
  trimmedAnonKey && trimmedAnonKey !== 'MY_INSFORGE_ANON_KEY' ? trimmedAnonKey : undefined;

export const hasInsForgeAnonKey = Boolean(anonKey);

// Capture any OAuth callback error before createClient() cleans query params from window.location.search
export const initialOAuthCallbackError: string | null = (() => {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const rawError = params.get('insforge_error') || params.get('error');
    if (!rawError) return null;
    return rawError === 'access_denied'
      ? 'Sign-in was cancelled. Please try again or use your email and password.'
      : `Authentication failed: ${rawError}`;
  } catch {
    return null;
  }
})();

export const insforge = createClient({
  baseUrl,
  ...(anonKey ? { anonKey } : {}),
});
