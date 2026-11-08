import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";
import { loadPdf } from "./loaders/pdfLoader";
import { loadMarkdownArticles, splitMarkdownSections } from "./loaders/markdownLoader";
import { loadSlackMessages } from "./loaders/slackLoader";
import type { NormalizedDocument } from "./types";

function validateDocuments(documents: NormalizedDocument[]): void {
  if (documents.length === 0) throw new Error("No documents loaded");

  const identities = new Set<string>();
  for (const document of documents) {
    if (!document.sourceId.trim()) {
      throw new Error(`Empty sourceId for ${document.source} document`);
    }
    if (!document.content.trim()) {
      throw new Error(`Empty document: ${document.source}:${document.sourceId}`);
    }
    const identity = JSON.stringify([document.source, document.sourceId]);
    if (identities.has(identity)) {
      throw new Error(`Duplicate document: ${document.source}:${document.sourceId}`);
    }
    identities.add(identity);
  }
}

/** Read all sources as PDF sections, Markdown sections and Slack threads. */
export async function loadDocuments(
  pdfDirectory = fileURLToPath(new URL("../knowledge_pdfs", import.meta.url))
): Promise<NormalizedDocument[]> {
  const pdfFiles = (await readdir(pdfDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map(entry => entry.name)
    .sort();
  if (pdfFiles.length === 0) {
    throw new Error(`No PDF files found in ${pdfDirectory}`);
  }

  console.log(`Found ${pdfFiles.length} PDF files`);
  const documents: NormalizedDocument[] = [];
  for (const file of pdfFiles) {
    console.log(`Loading PDF: ${file}`);
    documents.push(...await loadPdf(path.join(pdfDirectory, file)));
  }

  const articles = await loadMarkdownArticles();
  documents.push(...articles.flatMap(article => splitMarkdownSections(article)));
  documents.push(...await loadSlackMessages());

  validateDocuments(documents);
  return documents;
}
