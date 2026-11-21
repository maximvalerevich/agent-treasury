import { describe, expect, it } from 'vitest';
import { unwrapPreparedTx } from '../src/multihopper/signer.js';

describe('unwrapPreparedTx', () => {
  it('passes a bare base64 string through (keeperFundingTx, sessionInitTxs)', () => {
    expect(unwrapPreparedTx('AQAAAAAAAAAA')).toBe('AQAAAAAAAAAA');
  });

  it('unwraps the { base64 } objects the API returns inside routeInitTxs', () => {
    expect(unwrapPreparedTx({ base64: 'AgAAAAAAAAAA' })).toBe('AgAAAAAAAAAA');
  });

  it('throws on an unrecognised shape instead of silently signing garbage', () => {
    expect(() => unwrapPreparedTx({ tx: 'nope' } as never)).toThrow(/Unrecognised prepared transaction shape/);
  });
});
