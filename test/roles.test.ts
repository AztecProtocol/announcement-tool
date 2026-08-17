import { describe, it, expect } from 'vitest';
import { ROLES, parseRoles } from '../src/core/roles.js';

describe('ROLES', () => {
  it('contains the operator roles the docs use', () => {
    expect(ROLES).toContain('sequencer');
    expect(ROLES).toContain('prover');
  });
});

describe('parseRoles', () => {
  it('splits on commas and trims', () => {
    expect(parseRoles('sequencer, prover')).toEqual(['sequencer', 'prover']);
  });

  it('drops blanks', () => {
    expect(parseRoles('sequencer,,  , prover')).toEqual(['sequencer', 'prover']);
  });

  it('lowercases', () => {
    expect(parseRoles('Sequencer')).toEqual(['sequencer']);
  });

  it('removes duplicates but keeps order', () => {
    expect(parseRoles('prover, sequencer, prover')).toEqual(['prover', 'sequencer']);
  });

  it('allows a role outside the curated list', () => {
    // The vocabulary is a guide, not a closed enum — a new role must not be
    // blocked by a UI that predates it.
    expect(parseRoles('sequencer, archive-node')).toEqual(['sequencer', 'archive-node']);
  });

  it('returns an empty array for empty input', () => {
    expect(parseRoles('')).toEqual([]);
  });
});
