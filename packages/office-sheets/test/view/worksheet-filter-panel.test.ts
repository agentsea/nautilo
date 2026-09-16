// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Worksheet } from '../../src/view/worksheet';

const proto = Worksheet.prototype as unknown as {
  renderFilterPanel(): void;
  syncFilterPanelValuesSelectionState(filteredValues: string[]): void;
  syncFilterPanelApplyButtonState(): void;
  areStringSetsEqual(left: Set<string>, right: Set<string>): boolean;
  isFilterPanelDirty(state: FilterPanelState): boolean;
  applyFilterPanel(): Promise<void>;
  hideFilterPanel(): void;
};

type FilterPanelState = {
  col: number;
  values: string[];
  selected: Set<string>;
  initialSelected: Set<string>;
  search: string;
  visibleValueCount: number;
  mode: 'values';
  condition: { op: 'contains'; value: string };
  initialCondition: { op: 'contains'; value: string };
  hasExistingCondition: boolean;
};

function createContext(values: string[]) {
  const selected = new Set(values);
  const context = {
    theme: 'light',
    filterPanel: document.createElement('div'),
    filterPanelState: {
      col: 1,
      values,
      selected,
      initialSelected: new Set(values),
      search: '',
      visibleValueCount: 200,
      mode: 'values' as const,
      condition: { op: 'contains' as const, value: '' },
      initialCondition: { op: 'contains' as const, value: '' },
      hasExistingCondition: true,
    } satisfies FilterPanelState,
    sheet: {
      setColumnIncludedValues: vi.fn().mockResolvedValue(undefined),
      clearColumnFilter: vi.fn().mockResolvedValue(undefined),
    },
    render: vi.fn(),
    renderFilterPanel: proto.renderFilterPanel,
    syncFilterPanelValuesSelectionState:
      proto.syncFilterPanelValuesSelectionState,
    syncFilterPanelApplyButtonState: proto.syncFilterPanelApplyButtonState,
    areStringSetsEqual: proto.areStringSetsEqual,
    isFilterPanelDirty: proto.isFilterPanelDirty,
    applyFilterPanel: proto.applyFilterPanel,
    hideFilterPanel: vi.fn(),
  };
  return context;
}

describe('Worksheet filter panel value continuation', () => {
  it('reaches a value after 200 and preserves its selection through search and apply', async () => {
    const values = Array.from({ length: 450 }, (_, index) =>
      `value-${String(index).padStart(3, '0')}`,
    );
    const context = createContext(values);
    proto.renderFilterPanel.call(context as never);

    expect(
      context.filterPanel.querySelectorAll('input[data-wb-filter-value]'),
    ).toHaveLength(200);
    expect(
      context.filterPanel.querySelector('[data-wb-filter-visible-count]')
        ?.textContent,
    ).toBe('Showing 200 / 450');

    context.filterPanel
      .querySelector<HTMLButtonElement>('[data-wb-filter-show-more]')
      ?.click();
    context.filterPanel
      .querySelector<HTMLButtonElement>('[data-wb-filter-show-more]')
      ?.click();

    expect(
      context.filterPanel.querySelectorAll('input[data-wb-filter-value]'),
    ).toHaveLength(450);
    const lateValue = context.filterPanel.querySelector<HTMLInputElement>(
      'input[data-wb-filter-value="value-449"]',
    );
    expect(lateValue).not.toBeNull();
    lateValue!.checked = false;
    lateValue!.dispatchEvent(new Event('change', { bubbles: true }));

    const search = context.filterPanel.querySelector<HTMLInputElement>(
      'input[data-wb-filter-search="true"]',
    );
    search!.value = 'value-449';
    search!.dispatchEvent(new Event('input', { bubbles: true }));

    expect(context.filterPanelState.visibleValueCount).toBe(200);
    expect(
      context.filterPanel.querySelector<HTMLInputElement>(
        'input[data-wb-filter-value="value-449"]',
      )?.checked,
    ).toBe(false);

    context.filterPanel
      .querySelector<HTMLButtonElement>('[data-wb-filter-apply="true"]')
      ?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(context.sheet.setColumnIncludedValues).toHaveBeenCalledTimes(1);
    expect(context.sheet.setColumnIncludedValues).toHaveBeenCalledWith(
      1,
      values.slice(0, -1),
    );
  });
});
