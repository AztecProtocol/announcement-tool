import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { safeErrorMessage } from '../app/admin/safe-error-message.js';
import { FourEyesError } from '../src/core/announcements.js';

describe('safeErrorMessage', () => {
  it('passes through a plain Error message', () => {
    const err = new Error('Slug is required.');
    expect(safeErrorMessage(err, 'test')).toBe('Slug is required.');
  });

  it('maps a ZodError to its issue messages', () => {
    const schema = z.object({ title: z.string().min(1, 'Title is required.') });
    let caught: unknown;
    try {
      schema.parse({ title: '' });
    } catch (err) {
      caught = err;
    }
    expect(safeErrorMessage(caught, 'test')).toBe('Title is required.');
  });

  it('passes a FourEyesError through via its own branch', () => {
    const err = new FourEyesError();
    expect(safeErrorMessage(err, 'test')).toBe(err.message);
  });

  it('replaces a named Error subclass with the generic message — the regression guard for the plain-Error-only gate', () => {
    class DatabaseError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'DatabaseError';
      }
    }
    const err = new DatabaseError('connection string: postgres://user:pass@host/db');
    expect(safeErrorMessage(err, 'test')).toBe('Something went wrong — check the server logs.');
  });
});
