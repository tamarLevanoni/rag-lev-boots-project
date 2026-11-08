import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import type { ContentBlock, NormalizedDocument } from "../types";

type OutlineItem = { title: string; items?: OutlineItem[] };
const clean = (text: string) => text.replace(/\s+/g, " ").trim();
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const listStart = /^(?:[●○•▪*-]|\d+[.)]|[a-z][)])\s+/;

/** Reflow wrapped lines only after headings/sections have been located. */
export function pdfBlocks(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let lines: string[] = [];
  let kind: ContentBlock["kind"] = "paragraph";
  function flush() {
    const body = clean(lines.join(" "));
    if (body) blocks.push({ kind, text: body });
    lines = [];
    kind = "paragraph";
  }
  // A physical page break isn't a paragraph break (sentences often cross it).
  const normalized = text.replace(/\r/g, "").replace(/\s*\f\s*/g, "\n");
  for (const raw of normalized.split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (listStart.test(line)) { flush(); kind = "list-item"; }
    lines.push(line);
  }
  flush();
  return blocks;
}

export async function loadPdf(filePath: string): Promise<NormalizedDocument[]> {
  const filename = path.basename(filePath);
  const parser = new PDFParse({ data: new Uint8Array(await readFile(filePath)) });
  try {
    // pdf-parse must be called sequentially on a given parser.
    const extracted = await parser.getText({ pageJoiner: "\n\n" });
    const info = await parser.getInfo();
    const text = extracted.pages.map(page => page.text.trim()).join("\f");
    if (!text.trim()) throw new Error(`No extractable text in ${filename}`);
    const outline = (info.outline ?? []) as OutlineItem[];
    const wrapper = outline.length === 1 && outline[0].items?.length ? outline[0] : undefined;
    const chapters = wrapper?.items ?? outline;
    const documentTitle = clean(wrapper?.title || info.info?.Title || filename);
    const bounds: { path: string[]; start: number; end: number }[] = [];
    let from = 0;
    function locate(items: OutlineItem[], parents: string[] = []) {
      for (const item of items) {
        const title = clean(item.title);
        const pattern = title.split(" ").map(escapeRegex).join("\\s+");
        // Match an actual heading, rather than its occurrence in a paragraph.
        const regex = new RegExp(`(?:^|[\\n\\f])[^\\S\\n\\f]*${pattern}(?=\\s|$)`, "g");
        regex.lastIndex = from;
        const match = regex.exec(text);
        if (!match) throw new Error(`${filename}: PDF bookmark '${title}' not found in extracted text`);
        const sectionPath = [...parents, title];
        bounds.push({ path: sectionPath, start: match.index, end: regex.lastIndex });
        from = regex.lastIndex;
        locate(item.items ?? [], sectionPath);
      }
    }
    locate(chapters);
    const documents: NormalizedDocument[] = [];
    function add(sourceId: string, sectionPath: string[], raw: string, start: number) {
      if (sectionPath[0] === "Preface" && clean(raw) === documentTitle) return;
      const blocks = pdfBlocks(raw);
      if (!blocks.length) return;
      documents.push({
        source: "pdf", sourceId, content: blocks.map(block => block.text).join("\n\n"), blocks,
        metadata: {
          title: sectionPath.join(" > "), documentTitle, sectionPath, filePath,
          page: text.slice(0, start).split("\f").length,
        },
      });
    }
    if (!bounds.length) add(`${filename}#body`, ["Document body"], text, 0);
    else {
      // Preserve substantive prefaces regardless of length; title-only covers
      // already appear in every chunk header and need no separate embedding.
      add(`${filename}#preface`, ["Preface"], text.slice(0, bounds[0].start), 0);
      for (const [index, bound] of bounds.entries()) {
        add(`${filename}#section-${index}`, bound.path,
          text.slice(bound.end, bounds[index + 1]?.start ?? text.length), bound.end);
      }
    }
    if (!documents.length) throw new Error(`${filename}: no PDF sections extracted`);
    return documents;
  } finally {
    await parser.destroy();
  }
}
