import type { NormalizedDocument } from "./types";

export interface DocumentChunk {
  source: string;
  sourceId: string;
  chunkIndex: number;
  content: string;
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function contextHeader(document: NormalizedDocument): string {
  const meta = document.metadata;
  if (document.source === "slack") {
    const channel = meta?.channel ?? "unknown";
    return `Channel: ${channel}`;
  }
  const filename = document.sourceId.split("#")[0];
  if (document.source === "pdf") {
    return `Document: ${meta?.documentTitle ?? filename}\nSection: ${meta?.sectionPath?.join(" > ") ?? meta?.title ?? "Document body"}`;
  }
  if (document.source === "markdown") {
    return `Document: ${meta?.documentTitle ?? meta?.title ?? filename}\nSection: ${meta?.sectionPath?.join(" > ") ?? "Document body"}`;
  }
  return `Source: ${document.sourceId}`;
}

const TARGET_MIN = 150;
const TARGET_MAX = 300;
const PREFERRED_MIN = 100;
const HARD_MAX = 400;

interface Unit {
  text: string;
  separator: string;
}

function isHeading(text: string): boolean {
  return /^(?:Subsection:|#{1,6}\s)/.test(text) && !text.includes("\n");
}

function splitOversizedBlock(text: string, limit: number, target: number, refine = false): Unit[] {
  // Keep a paragraph, list, table, or message intact whenever it fits.
  if (!refine && countWords(text) <= limit) return [{ text, separator: "\n\n" }];

  const lines = text.split(/\n/).map(line => line.trim()).filter(Boolean);
  const parts = lines.length > 1 ? lines : text.split(/(?<=[.!?。！？])\s+/u);
  const separator = lines.length > 1 ? "\n" : " ";
  return parts.flatMap(part => {
    if (countWords(part) <= limit) {
      if (refine && lines.length > 1 && countWords(part) > TARGET_MAX) {
        const units = splitOversizedBlock(part, limit, target, true);
        units[0].separator = separator;
        return units;
      }
      return [{ text: part, separator }];
    }
    // A line may still contain several complete sentences.
    if (lines.length > 1) {
      const units = splitOversizedBlock(part, limit, target);
      units[0].separator = separator;
      return units;
    }
    // Only an oversized sentence requires word splitting. Balance the pieces
    // up front so a long sentence cannot create a tiny trailing fragment.
    const words = part.split(/\s+/);
    const pieces = Math.ceil(words.length / target);
    const size = Math.ceil(words.length / pieces);
    const units: Unit[] = [];
    for (let i = 0; i < words.length; i += size) {
      units.push({ text: words.slice(i, i + size).join(" "), separator: " " });
    }
    return units;
  });
}

function sizeCost(words: number, maxWords: number): number {
  const lower = Math.min(TARGET_MIN, maxWords);
  const upper = Math.min(TARGET_MAX, maxWords);
  const minimum = Math.min(PREFERRED_MIN, maxWords);
  const ideal = (lower + upper) / 2;
  const outsideTarget = Math.max(lower - words, words - upper, 0);
  const belowMinimum = Math.max(minimum - words, 0);
  // Soft penalties allow short complete units and coherent blocks up to 400.
  return 1 + ((words - ideal) / ideal) ** 2
    + (outsideTarget / 50) ** 2 + (belowMinimum / 25) ** 2;
}

export function splitIntoChunks(
  document: NormalizedDocument,
  maxWords = HARD_MAX
): DocumentChunk[] {
  if (!Number.isInteger(maxWords) || maxWords < 1) {
    throw new Error("maxWords must be a positive integer");
  }
  maxWords = Math.min(maxWords, HARD_MAX);
  if (!document.content.trim()) return [];

  const header = contextHeader(document);
  // Repeat only source text, never an inferred topic or a neighboring thread.
  // Bound the excerpt so a long opening cannot consume the entire chunk.
  const openingWords = document.openingMessage?.trim().split(/\s+/) ?? [];
  const openingBudget = Math.max(0, Math.min(80, Math.floor((maxWords - countWords(header) - 24) / 3)));
  const opening = openingWords.slice(0, openingBudget).join(" ");
  const continuationHeader = document.source === "slack" && opening
    ? `${header}\nOpening message${openingWords.length > openingBudget ? " excerpt" : ""}: ${opening}`
    : header;
  const bodyLimit = maxWords - countWords(continuationHeader);
  if (bodyLimit < 20) throw new Error("Not enough words left after context header");

  if (document.blocks && document.blocks.map(block => block.text).join("\n\n") !== document.content) {
    throw new Error(`Blocks do not match document content: ${document.sourceId}`);
  }
  const blocks = document.blocks ?? document.content.trim().split(/\n\s*\n/)
    .map(text => ({ kind: "paragraph" as const, text: text.trim() })).filter(block => block.text);

  const target = Math.min(bodyLimit, Math.max(1, 225 - countWords(header)));
  function makeUnits(refine: boolean): Unit[] {
    let headingWords = 0;
    return blocks.flatMap(block => {
      const paragraph = block.text;
      const heading = document.source === "markdown" && isHeading(paragraph);
      const speaker = block.kind === "message" && block.speaker ? `${block.speaker}: ` : "";
      const limit = bodyLimit - headingWords - countWords(speaker);
      if (limit < 1) throw new Error(`Heading leaves no room for content: ${document.sourceId}`);
      const parts = splitOversizedBlock(
        speaker && paragraph.startsWith(speaker) ? paragraph.slice(speaker.length) : paragraph,
        limit, Math.min(target, limit),
        refine && countWords(paragraph) > TARGET_MAX - countWords(header)
      );
      if (speaker) parts.forEach(part => { part.text = `${speaker}${part.text}`; });
      headingWords = heading ? headingWords + countWords(paragraph) : 0;
      parts[0].separator = "\n\n";
      return parts;
    });
  }

  // Choose boundaries together instead of filling to 400 then leaving a tail.
  // Only this document/section/thread participates; different documents are
  // never combined merely to reach a preferred size.
  function plan(units: Unit[]) {
    const weights = units.map(unit => countWords(unit.text));
    const costs = new Array<number>(units.length + 1).fill(Infinity);
    const ends = new Array<number>(units.length);
    costs[units.length] = 0;
    for (let start = units.length - 1; start >= 0; start--) {
      let words = countWords(start === 0 ? header : continuationHeader);
      for (let end = start; end < units.length; end++) {
        words += weights[end];
        if (words > maxWords) break;
        // Keep a Markdown subsection heading with the following content.
        if (document.source === "markdown" && end < units.length - 1 && isHeading(units[end].text)) continue;
        const cost = sizeCost(words, maxWords) + costs[end + 1];
        if (cost < costs[start]) {
          costs[start] = cost;
          ends[start] = end + 1;
        }
      }
    }
    return { ends, cost: costs[0] };
  }

  let units = makeUnits(false);
  let selection = plan(units);
  let hasShortChunk = false;
  for (let start = 0; start < units.length;) {
    const end = selection.ends[start];
    if (end === undefined) break;
    const words = countWords(header) + units.slice(start, end)
      .reduce((total, unit) => total + countWords(unit.text), 0);
    if (words < PREFERRED_MIN) hasShortChunk = true;
    start = end;
  }
  if (hasShortChunk) {
    // When an intact long block leaves a small neighbor, expose its sentence
    // or list-item boundaries. Never split a fitting sentence just for size.
    const refined = makeUnits(true);
    const candidate = plan(refined);
    if (candidate.cost < selection.cost) {
      units = refined;
      selection = candidate;
    }
  }

  const chunks: DocumentChunk[] = [];
  for (let start = 0; start < units.length;) {
    const end = selection.ends[start];
    if (end === undefined) {
      throw new Error(`Cannot preserve heading boundary within ${maxWords} words: ${document.sourceId}`);
    }
    const body = units.slice(start, end).map((unit, index) =>
      `${index === 0 ? "" : unit.separator}${unit.text}`
    ).join("");
    chunks.push({
      source: document.source,
      sourceId: document.sourceId,
      chunkIndex: chunks.length,
      content: `${start === 0 ? header : continuationHeader}\n\n${body}`,
    });
    start = end;
  }
  return chunks;
}
