export interface ConductResearch {
  research_topic: string;
}

export type ResearchComplete = Record<string, never>;

export interface ClarifyWithUser {
  need_clarification: boolean;
  question: string;
  verification: string;
}
