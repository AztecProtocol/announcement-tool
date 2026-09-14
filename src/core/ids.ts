import { ulid } from 'ulid';
import { randomBytes } from 'node:crypto';

// makeSlug lives in slug.ts so the compose form (a client component) can import
// it without dragging this module's node:crypto import into the browser bundle.
// Re-exported here for the server-side callers that always used this path.
export { makeSlug } from './slug.js';

export const newAnnouncementId = () => `ann_${ulid()}`;
export const newSubscriptionId = () => `sub_${ulid()}`;
export const newTemplateId = () => `tpl_${ulid()}`;
export const newSecret = () => `whsec_${randomBytes(24).toString('hex')}`;
export const newToken = () => randomBytes(16).toString('hex');
