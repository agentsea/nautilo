import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { evaluate } from '../../src/formula/formula';
import { Cell } from '../../src/model/core/types';

// Date-only strings such as "2024-03-15" are calendar dates. These checks run
// the date functions in time zones on both sides of UTC, so the result does not
// depend on the zone of the machine running the suite.
const zones = ['America/New_York', 'America/Los_Angeles', 'Pacific/Auckland'];

for (const zone of zones) {
  describe(`date functions in ${zone}`, () => {
    // Node re-reads TZ when it changes, so Date's local getters follow it.
    beforeAll(() => {
      vi.stubEnv('TZ', zone);
    });

    afterAll(() => {
      vi.unstubAllEnvs();
    });

    it('reads a date-only string as that calendar day', () => {
      expect(evaluate('=DAY("2024-03-15")')).toBe('15');
      expect(evaluate('=MONTH("2024-03-01")')).toBe('3');
      expect(evaluate('=YEAR("2024-01-01")')).toBe('2024');
      expect(evaluate('=WEEKDAY("2024-03-17")')).toBe('1');
      expect(evaluate('=DATEVALUE("2024-03-15")')).toBe('2024-03-15');
      expect(evaluate('=DAY(DATE(2024,3,15))')).toBe('15');
    });

    it('keeps date arithmetic on calendar days', () => {
      expect(evaluate('=EDATE("2024-03-15",-1)')).toBe('2024-02-15');
      expect(evaluate('=EOMONTH("2024-01-15",1)')).toBe('2024-02-29');
      expect(evaluate('=NETWORKDAYS("2024-03-11","2024-03-15")')).toBe('5');
      expect(evaluate('=WORKDAY("2024-01-05",1)')).toBe('2024-01-08');
      expect(evaluate('=YEARFRAC("2024-01-01","2024-07-01",0)')).toBe('0.5');
    });

    it('counts weeks across a daylight saving change', () => {
      // 17 March 2024 is a Sunday, one week after the US clocks went forward.
      expect(evaluate('=WEEKNUM("2024-03-17")')).toBe('12');
      expect(evaluate('=WEEKNUM("2024-03-16")')).toBe('11');
    });

    it('matches holidays on the same calendar day', () => {
      const grid = new Map<string, Cell>();
      grid.set('A1', { v: '2024-03-13' } as Cell);
      expect(evaluate('=NETWORKDAYS.INTL("2024-03-11","2024-03-15",1,A1)', grid)).toBe('4');
      expect(evaluate('=WORKDAY.INTL("2024-03-12",1,1,A1)', grid)).toBe('2024-03-14');
    });
  });
}
