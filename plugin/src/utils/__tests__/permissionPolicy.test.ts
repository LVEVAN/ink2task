import {readFileSync} from 'fs';
import {join} from 'path';
import {
  PERMISSIONS,
  REQUIRED,
  REQUESTED,
  isGranted,
  explainDenied,
  permissionReason,
  permissionLabel,
} from '../permissionPolicy';

describe('permission results', () => {
  it('treats both yes answers as granted', () => {
    expect(isGranted(1)).toBe(true); // this session only
    expect(isGranted(2)).toBe(true); // always
  });

  it('treats refusal and a dismissed dialog as not granted', () => {
    expect(isGranted(0)).toBe(false);
    expect(isGranted(-1)).toBe(false);
    expect(isGranted(undefined)).toBe(false);
    expect(isGranted(null)).toBe(false);
  });
});

describe('what we ask for', () => {
  it('asks for exactly what PluginConfig.json declares', () => {
    // The real drift risk, and the reason this reads the shipped file rather
    // than a copy of the list: requesting a permission that is not declared
    // there fails with 1500, and declaring one we never request is dead weight
    // the user still gets asked about at install time.
    const declared: string[] = JSON.parse(
      readFileSync(join(__dirname, '../../../PluginConfig.json'), 'utf8'),
    )['uses-permissions'];
    expect(declared.slice().sort()).toEqual(REQUESTED.slice().sort());
  });

  it('blocks on the three a sync genuinely cannot work without', () => {
    expect(REQUIRED.slice().sort()).toEqual(
      [PERMISSIONS.INTERNET, PERMISSIONS.FILE_READ, PERMISSIONS.FILE_WRITE].sort(),
    );
  });

  it('does not let FILE:DELETE block a sync', () => {
    // It gates deleting a real FILE, which we do once, for a leftover from the
    // rename. Element and page deletion go through FILE:WRITE.
    expect(REQUESTED).toContain(PERMISSIONS.FILE_DELETE);
    expect(REQUIRED).not.toContain(PERMISSIONS.FILE_DELETE);
  });

  it('gives every requested permission a reason for the declined dialog', () => {
    for (const name of REQUESTED) {
      expect(permissionReason(name)).toBeTruthy();
    }
  });
});

describe('explainDenied', () => {
  it('says nothing when nothing was denied', () => {
    expect(explainDenied([])).toBe('');
  });

  it('names one refusal in plain words', () => {
    const msg = explainDenied([PERMISSIONS.INTERNET]);
    expect(msg).toContain('internet access');
    expect(msg).toContain('Nothing was synced');
    expect(msg).not.toContain('plugin.permission');
  });

  it('lists several readably', () => {
    const msg = explainDenied([PERMISSIONS.INTERNET, PERMISSIONS.FILE_WRITE]);
    expect(msg).toContain('internet access and saving to your notes and settings');
  });

  it('falls back to the raw name for anything unrecognised', () => {
    expect(permissionLabel('plugin.permission.SOMETHING_NEW')).toBe(
      'plugin.permission.SOMETHING_NEW',
    );
  });
});
