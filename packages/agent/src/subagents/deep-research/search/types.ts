export interface SearchResultItem {
  title?: string;
  url: string;
  snippet?: string;
  rawContent?: string;
  [key: string]: unknown;
}

export interface SearchResults {
  provider: string;
  query: string;
  items: SearchResultItem[];
}
