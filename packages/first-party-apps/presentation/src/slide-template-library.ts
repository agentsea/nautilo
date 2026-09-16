export interface SlideTemplateSummary {
  id: string;
  name: string;
}

export interface SlidesTemplateLibrary {
  list(): Promise<SlideTemplateSummary[]>;
  read(id: string): Promise<{ content: string }>;
  save(input: { name: string; content: string }): Promise<SlideTemplateSummary>;
  remove(id: string): Promise<void>;
}
