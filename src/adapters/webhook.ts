export const makeWebhookAdapter = (..._args: unknown[]) => ({ channel: 'webhook', deliver: async () => { throw new Error('not implemented'); } });
