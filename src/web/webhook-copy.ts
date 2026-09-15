/** Shown when the form re-registers a URL that already has a row. The core
 * module keeps its generic message for the API path (P22); the form has no
 * secret field, so a person can only be the URL's owner or a stranger, and
 * neither learns anything new from this sentence that the generic one did
 * not already imply. */
export const ALREADY_REGISTERED =
  'This URL is already registered. If it is yours, open its webhook page and use Remove webhook, then register again.';
