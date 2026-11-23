import { createClient } from '@insforge/sdk';

const DEFAULT_INSFORGE_URL = 'https://ypbur365.us-east.insforge.app';

const baseUrl =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_INSFORGE_URL) ||
  DEFAULT_INSFORGE_URL;
const anonKey =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_INSFORGE_ANON_KEY) ||
  undefined;

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
