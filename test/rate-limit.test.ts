import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../src/core/rate-limit.js';

describe('createRateLimiter', () => {
  it('allows up to the limit within a window', () => {
    const rl = createRateLimiter({ limit: 3, windowMs: 1000, now: () => 0 });
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(false);
  });

  it('counts each key separately', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    expect(rl.check('a')).toBe(true);
    expect(rl.check('b')).toBe(true);
    expect(rl.check('a')).toBe(false);
  });

  it('lets the window expire', () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
    expect(rl.check('a')).toBe(true);
    expect(rl.check('a')).toBe(false);
    t = 1001;
    expect(rl.check('a')).toBe(true);
  });

  it('does not grow without bound as keys expire', () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 100, now: () => t });
    for (let i = 0; i < 500; i++) { rl.check(`key-${i}`); t += 10; }
    expect(rl.size()).toBeLessThan(500);
  });
});
