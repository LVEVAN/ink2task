import {isMantaClass, MANTA_WIDTH, MANTA_HEIGHT} from '../deviceSize';

describe('isMantaClass', () => {
  const NOMAD = {width: 1404, height: 1872};
  const MANTA = {width: MANTA_WIDTH, height: MANTA_HEIGHT};

  it('trusts device type 5', () => {
    expect(isMantaClass({deviceType: 5})).toBe(true);
  });

  it('detects a Manta panel even when the enum says Nomad', () => {
    // The real case, 2026-08-22: a Manta reporting ro.product.model
    // "Supernote Nomad" with a 1920x2560 panel. The panel cannot lie.
    expect(isMantaClass({deviceType: 4, screen: MANTA, pixelRatio: 1})).toBe(true);
  });

  it('converts DP to pixels, which is what RN actually reports', () => {
    // Device-observed 2026-08-23: a Manta reads 1024 x 1365.33 dp at ratio
    // 1.875. Without the ratio those numbers look far smaller than Manta and
    // the whole screen check was dead code.
    const dp = {width: 1024, height: 1365.3333333333333};
    expect(isMantaClass({screen: dp, pixelRatio: 1.875})).toBe(true);
    expect(isMantaClass({screen: dp})).toBe(false); // no ratio: cannot tell
  });

  it('does not mistake an A5X for a Manta once scaled', () => {
    expect(isMantaClass({screen: {width: 748.8, height: 998.4}, pixelRatio: 1.875})).toBe(false);
  });

  it('detects a Manta panel when the enum is unavailable', () => {
    expect(isMantaClass({screen: MANTA, pixelRatio: 1})).toBe(true);
  });

  it('is orientation agnostic', () => {
    expect(isMantaClass({screen: {width: MANTA_HEIGHT, height: MANTA_WIDTH}, pixelRatio: 1})).toBe(true);
  });

  it('says no for A5X and Nomad panels', () => {
    expect(isMantaClass({deviceType: 3, screen: NOMAD, pixelRatio: 1})).toBe(false);
    expect(isMantaClass({deviceType: 4, screen: NOMAD, pixelRatio: 1})).toBe(false);
  });

  it('says no when nothing is known, rather than guessing Manta', () => {
    // Falling back to the standard template is the safe default: it scales to
    // fill a larger page, whereas a Manta template on a small page would not.
    expect(isMantaClass({})).toBe(false);
    expect(isMantaClass({screen: {width: 0, height: 0}})).toBe(false);
  });

  it('needs BOTH edges to be at least Manta size', () => {
    expect(isMantaClass({screen: {width: 1404, height: 2560}, pixelRatio: 1})).toBe(false);
  });
});
