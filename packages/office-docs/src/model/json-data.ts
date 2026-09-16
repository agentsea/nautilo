/**
 * Serialize plain document data without consuming the call stack for nested
 * tables. Scalar escaping, omitted object values and null array slots follow
 * JSON.stringify. Document models contain only plain objects and arrays (no
 * class instances, toJSON hooks or replacers).
 */
export function stringifyJsonData(value: unknown): string {
  type Work = { value: unknown } | { text: string; leave?: object };
  const work: Work[] = [{ value }];
  const ancestors = new Set<object>();
  const parts: string[] = [];
  while (work.length > 0) {
    const item = work.pop()!;
    if ('text' in item) {
      parts.push(item.text);
      if (item.leave) ancestors.delete(item.leave);
      continue;
    }
    const current = item.value;
    if (current === null || typeof current !== 'object') {
      const scalar = JSON.stringify(current);
      if (scalar === undefined) throw new TypeError('Document data must be JSON serializable');
      parts.push(scalar);
      continue;
    }
    if (ancestors.has(current)) throw new TypeError('Circular document data');
    ancestors.add(current);
    if (Array.isArray(current)) {
      parts.push('[');
      work.push({ text: ']', leave: current });
      for (let i = current.length - 1; i >= 0; i--) {
        if (i < current.length - 1) work.push({ text: ',' });
        const entry: unknown = current[i];
        work.push({ value: isOmitted(entry) ? null : entry });
      }
    } else {
      parts.push('{');
      work.push({ text: '}', leave: current });
      const entries = Object.entries(current as Record<string, unknown>).filter(([, entry]) => !isOmitted(entry));
      for (let i = entries.length - 1; i >= 0; i--) {
        if (i < entries.length - 1) work.push({ text: ',' });
        const [key, entry] = entries[i];
        work.push({ value: entry });
        work.push({ text: `${JSON.stringify(key)}:` });
      }
    }
  }
  return parts.join('');
}

function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

export function cloneJsonData<T>(value: T): T {
  return JSON.parse(stringifyJsonData(value)) as T;
}
