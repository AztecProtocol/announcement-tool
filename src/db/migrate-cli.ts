import { migrate } from './migrate.js';
const url = process.env.DATABASE_URL ?? 'postgres://announce:announce@127.0.0.1:5499/announce';
const applied = await migrate(url);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
