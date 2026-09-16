/**
 * Contextual search primitive for the Browser column (D057 2a.1.1,
 * extended D075 Chunk 3).
 *
 * Intentionally dumb: controlled input with onChange + onKeyDown
 * bubbling up so each tab decides what "search" means for its
 * content. Files tab uses it for real debounced filtering in Chunk 3;
 * Artifacts/Activity just render (no filtering) so typing is a no-op.
 *
 * Forwards its `ref` to the underlying input so the Files tab's
 * keyboard handler can programmatically focus + select the input
 * when the user hits `/` anywhere in the tree.
 */

import { Search } from "lucide-react";
import { forwardRef, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";

interface SearchBarProps {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
}

export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(
  function SearchBar({ value, onChange, onKeyDown, placeholder }, ref) {
    return (
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-muted"
          aria-hidden="true"
        />
        <input
          ref={ref}
          type="text"
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? "Search…"}
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded-md border border-border bg-background-element pl-7 pr-2 py-1 text-xs leading-5 text-foreground placeholder:text-foreground-muted outline-none focus:border-[var(--border-active,_currentColor)]"
        />
      </div>
    );
  },
);
