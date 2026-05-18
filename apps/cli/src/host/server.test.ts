import { describe, expect, test } from 'bun:test';
import { parseHostCommandTokens } from './server';
import { CliError } from '../lib/errors';

describe('parseHostCommandTokens', () => {
  test('parses --stdio', () => {
    expect(parseHostCommandTokens(['--stdio'])).toEqual({
      stdio: true,
      help: false,
      requestTimeoutMs: undefined,
    });
  });

  test('parses --help and -h', () => {
    expect(parseHostCommandTokens(['--help'])).toEqual({
      stdio: false,
      help: true,
      requestTimeoutMs: undefined,
    });
    expect(parseHostCommandTokens(['-h'])).toEqual({
      stdio: false,
      help: true,
      requestTimeoutMs: undefined,
    });
  });

  test('rejects unknown options', () => {
    expect(() => parseHostCommandTokens(['--bogus'])).toThrow(CliError);
  });

  describe('--request-timeout-ms', () => {
    test('accepts space-separated value', () => {
      expect(parseHostCommandTokens(['--stdio', '--request-timeout-ms', '120000'])).toEqual({
        stdio: true,
        help: false,
        requestTimeoutMs: 120000,
      });
    });

    test('accepts equals-separated value', () => {
      expect(parseHostCommandTokens(['--stdio', '--request-timeout-ms=180000'])).toEqual({
        stdio: true,
        help: false,
        requestTimeoutMs: 180000,
      });
    });

    test('rejects missing value', () => {
      expect(() => parseHostCommandTokens(['--request-timeout-ms'])).toThrow(/requires a positive integer/);
    });

    test('rejects empty value', () => {
      expect(() => parseHostCommandTokens(['--request-timeout-ms='])).toThrow(/requires a positive integer/);
    });

    test('rejects non-numeric value', () => {
      expect(() => parseHostCommandTokens(['--request-timeout-ms', 'soon'])).toThrow(/positive integer/);
    });

    test('rejects zero and negatives', () => {
      expect(() => parseHostCommandTokens(['--request-timeout-ms', '0'])).toThrow(/positive integer/);
      expect(() => parseHostCommandTokens(['--request-timeout-ms', '-1'])).toThrow(/positive integer/);
    });

    test('rejects floats', () => {
      expect(() => parseHostCommandTokens(['--request-timeout-ms', '12.5'])).toThrow(/positive integer/);
    });
  });
});
