/**
 * In-memory jest mock for react-native-fs.
 *
 * There's no real filesystem (or native module) available under jest, so
 * anything in src/utils that persists via RNFS (config.ts's loadX/saveX
 * pairs) needs this to be testable at all. Auto-mocked by Jest for every
 * test in this project -- no `jest.mock('react-native-fs')` needed at the
 * call site -- because this file lives at <rootDir>/__mocks__/react-native-fs.js,
 * which Jest treats specially for node_modules packages.
 *
 * Minimal on purpose: only what config.ts's persistence functions actually
 * call (exists, mkdir, readFile, writeFile). Add more as needed rather than
 * trying to model the whole RNFS surface up front.
 */
let files = new Map();

function normalize(path) {
  return String(path);
}

module.exports = {
  /** Test-only helper: wipes all in-memory files between tests. Not part of the real RNFS API. */
  __reset() {
    files = new Map();
  },
  /** Test-only helper: inspect what's "on disk" without going through readFile. */
  __dump() {
    return Object.fromEntries(files);
  },

  async exists(path) {
    return files.has(normalize(path));
  },
  async mkdir(_path) {
    // No real directory concept needed for a flat in-memory map.
    return undefined;
  },
  async readFile(path, _encoding) {
    const key = normalize(path);
    if (!files.has(key)) {
      const err = new Error(`ENOENT: no such file, open '${path}'`);
      err.code = 'ENOENT';
      throw err;
    }
    return files.get(key);
  },
  async writeFile(path, contents, _encoding) {
    files.set(normalize(path), contents);
    return undefined;
  },
  async unlink(path) {
    files.delete(normalize(path));
    return undefined;
  },
  async copyFile(from, to) {
    const key = normalize(from);
    if (!files.has(key)) {
      const err = new Error(`ENOENT: no such file, open '${from}'`);
      err.code = 'ENOENT';
      throw err;
    }
    files.set(normalize(to), files.get(key));
    return undefined;
  },
  DocumentDirectoryPath: '/mock-document-dir',
};
