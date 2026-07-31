/**
 * Loads OAuth app credentials from a plain, non-hidden file so users don't have
 * to wrangle a dot-prefixed `.env` in Finder.
 *
 * Prefers `credentials.env`; falls back to `.env` if that's what's present.
 * Import this (`import './env.js'`) before anything reads process.env.
 */
import {config} from 'dotenv';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const name of ['credentials.env', '.env']) {
  const path = join(projectRoot, name);
  if (existsSync(path)) {
    config({path});
    break;
  }
}
