/**
 * sqlite.js — read-only access to agents' SQLite indexes through Node's
 * built-in `node:sqlite` (Node >= 22.5, no npm dependency).
 *
 * Node 22 prints an ExperimentalWarning when the module loads; it is
 * suppressed here so copass output stays clean. Callers must treat a null
 * database (old Node, locked or missing file) as "fall back to file scanning".
 */

let DatabaseSync;

async function loadDriver() {
  if (DatabaseSync !== undefined) return DatabaseSync;
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) =>
    String(warning?.message ?? warning).includes('SQLite') ? undefined : emit.call(process, warning, ...rest);
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    DatabaseSync = null;
  } finally {
    process.emitWarning = emit;
  }
  return DatabaseSync;
}

/**
 * Open a database read-only, or return null.
 *
 * @param {string} path
 * @returns {Promise<import('node:sqlite').DatabaseSync|null>}
 */
export async function openReadOnly(path) {
  const Driver = await loadDriver();
  if (!Driver) return null;
  try {
    return new Driver(path, { readOnly: true });
  } catch {
    return null;
  }
}

/**
 * Run one query against a database file and close it. Returns null when the
 * database cannot be opened or queried (so callers can fall back to scanning
 * files), and [] when it simply has no matching rows.
 *
 * @param {string} path
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {Promise<any[]|null>}
 */
export async function queryAll(path, sql, params = []) {
  const db = await openReadOnly(path);
  if (!db) return null;
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return null;
  } finally {
    db.close();
  }
}
