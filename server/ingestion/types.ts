
export type KnowledgeSource = "pdf" | "markdown" | "slack";

/** Structural boundaries survive parsing; these are not database columns. */
export interface ContentBlock {
  kind: "paragraph" | "list-item" | "table-row" | "code" | "message";
  text: string;
  speaker?: string;
}

export interface NormalizedDocument {
  source: KnowledgeSource;
  sourceId: string;
  content: string;
  blocks?: ContentBlock[];
  openingMessage?: string;
  metadata?: {
    title?: string;
    documentTitle?: string;
    sectionPath?: string[];
    filePath?: string;
    page?: number;
    channel?: string;
    user?: string;
    timestamp?: string;
    threadTs?: string;
  };
}
