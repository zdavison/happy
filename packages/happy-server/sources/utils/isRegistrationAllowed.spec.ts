import { describe, it, expect } from 'vitest';
import { isRegistrationAllowed } from './isRegistrationAllowed';

describe('isRegistrationAllowed', () => {
    const KEY = 'a1b2c3';

    it('allows any key when the allowlist is undefined (bootstrap)', () => {
        expect(isRegistrationAllowed(KEY, undefined)).toBe(true);
    });

    it('allows any key when the allowlist is empty string', () => {
        expect(isRegistrationAllowed(KEY, '')).toBe(true);
    });

    it('allows any key when the allowlist is only whitespace/commas', () => {
        expect(isRegistrationAllowed(KEY, '  , ,')).toBe(true);
    });

    it('allows a key that is in the allowlist', () => {
        expect(isRegistrationAllowed(KEY, 'a1b2c3')).toBe(true);
    });

    it('rejects a key that is not in the allowlist', () => {
        expect(isRegistrationAllowed(KEY, 'deadbeef')).toBe(false);
    });

    it('matches case-insensitively', () => {
        expect(isRegistrationAllowed('A1B2C3', 'a1b2c3')).toBe(true);
        expect(isRegistrationAllowed('a1b2c3', 'A1B2C3')).toBe(true);
    });

    it('trims whitespace around entries', () => {
        expect(isRegistrationAllowed(KEY, '  a1b2c3  ,  deadbeef ')).toBe(true);
    });

    it('supports multiple keys', () => {
        expect(isRegistrationAllowed('deadbeef', 'a1b2c3,deadbeef,cafe')).toBe(true);
        expect(isRegistrationAllowed('nope', 'a1b2c3,deadbeef,cafe')).toBe(false);
    });
});
