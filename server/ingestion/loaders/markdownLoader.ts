import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { ContentBlock, NormalizedDocument } from "../types";

const BASE_URL =
  "https://gist.githubusercontent.com/JonaCodes/394d01021d1be03c9fe98cd9696f5cf3/raw";

const ARTICLE_IDS = [
  "military-deployment-report",
  "urban-commuting",
  "hover-polo",
  "warehousing",
  "consumer-safety",
];

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  lang?: string | null;
  url?: string;
  alt?: string | null;
  identifier?: string;
  checked?: boolean | null;
};

type Definitions = Map<string, string>;

function parse(content: string): MdNode {
  return unified().use(remarkParse).use(remarkGfm).parse(content) as unknown as MdNode;
}

function definitionsFor(root: MdNode): Definitions {
  const definitions: Definitions = new Map();
  for (const node of root.children ?? []) {
    if (node.type === "definition" && node.identifier && node.url) {
      definitions.set(node.identifier.toLowerCase(), node.url);
    }
  }
  return definitions;
}

function cleanInline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function inline(node: MdNode, definitions: Definitions): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value ?? "";
    case "break":
      return " ";
    case "image":
    case "imageReference":
      return node.alt ?? "";
    case "footnoteReference":
      return ` [Footnote ${node.identifier ?? ""}]`;
    case "link":
    case "linkReference": {
      const label = cleanInline((node.children ?? []).map(n => inline(n, definitions)).join(""));
      const url = node.url ?? (node.identifier ? definitions.get(node.identifier.toLowerCase()) : undefined);
      return url && label !== url ? `${label || "Link"} (${url})` : (label || url || "");
    }
    default:
      // This keeps words inside emphasis/strong/delete intact, without markup.
      return node.children
        ? node.children.map(n => inline(n, definitions)).join("")
        : (node.value ?? "");
  }
}

function block(node: MdNode, definitions: Definitions): string {
  switch (node.type) {
    case "heading":
      return `Subsection: ${cleanInline(inline(node, definitions))}`;
    case "paragraph":
      return cleanInline(inline(node, definitions));
    case "list":
      return (node.children ?? []).map((item, index) => {
        const marker = node.ordered ? `${(node.start ?? 1) + index}.` : "-";
        const checkbox = item.checked === true ? " [done]" : item.checked === false ? " [not done]" : "";
        const body = (item.children ?? []).map(child => block(child, definitions)).filter(Boolean).join("\n  ");
        return body ? `${marker}${checkbox} ${body}` : "";
      }).filter(Boolean).join("\n");
    case "table": {
      const [head, ...rows] = node.children ?? [];
      const columns = (head?.children ?? []).map(cell => cleanInline(inline(cell, definitions)));
      if (rows.length === 0) return columns.join("; ");
      // Each row explicitly repeats column names, preserving table relationships.
      return rows.map(row => (row.children ?? []).map((cell, index) =>
        `${columns[index] || `Column ${index + 1}`}: ${cleanInline(inline(cell, definitions))}`
      ).join("; ")).join("\n");
    }
    case "code":
      return node.value?.trim() ? `Code${node.lang ? ` (${node.lang})` : ""}:\n${node.value.trim()}` : "";
    case "blockquote":
    case "listItem":
    case "footnoteDefinition": {
      const contents = (node.children ?? []).map(child => block(child, definitions)).filter(Boolean).join("\n\n");
      return node.type === "footnoteDefinition" && contents
        ? `Footnote ${node.identifier ?? ""}: ${contents}`
        : contents;
    }
    case "html":
      return cleanInline((node.value ?? "").replace(/<[^>]*>/g, " "));
    case "definition":
    case "thematicBreak":
      return "";
    default:
      return cleanInline(inline(node, definitions));
  }
}

export async function loadMarkdownArticles(): Promise<NormalizedDocument[]> {
  const documents: NormalizedDocument[] = [];
  for (const [index, articleId] of ARTICLE_IDS.entries()) {
    const filename = `article-${index + 1}_${articleId}.md`;
    const url = `${BASE_URL}/${filename}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch ${filename}: HTTP ${response.status}`);
    const content = (await response.text()).trim();
    if (!content) throw new Error(`Empty article: ${filename}`);
    const root = parse(content);
    const definitions = definitionsFor(root);
    const mainHeading = (root.children ?? []).find(n => n.type === "heading" && n.depth === 1);
    const title = mainHeading ? cleanInline(inline(mainHeading, definitions)) || articleId : articleId;
    documents.push({
      source: "markdown", sourceId: filename, content,
      metadata: { title, filePath: url },
    });
    console.log(`Loaded: ${filename}`);
  }
  return documents;
}

export function splitMarkdownSections(document: NormalizedDocument): NormalizedDocument[] {
  const root = parse(document.content);
  const definitions = definitionsFor(root);
  const mainHeading = (root.children ?? []).find(n => n.type === "heading" && n.depth === 1);
  const documentTitle = mainHeading
    ? cleanInline(inline(mainHeading, definitions)) || document.metadata?.title || document.sourceId
    : document.metadata?.title || document.sourceId;

  const sections: NormalizedDocument[] = [];
  const headings: { depth: number; title: string }[] = [];
  let sectionNodes: MdNode[] = [];
  let index = 0;

  function flush() {
    const blocks: ContentBlock[] = sectionNodes.flatMap<ContentBlock>(node => {
      if (node.type === "list") {
        // Render each item separately without breaking its nested list/body.
        return (node.children ?? []).map((item, itemIndex) => ({
          kind: "list-item" as const,
          text: block({ ...node, start: (node.start ?? 1) + itemIndex, children: [item] }, definitions),
        }));
      }
      const text = block(node, definitions);
      if (node.type === "table") return text.split("\n").map(text => ({ kind: "table-row" as const, text }));
      return [{ kind: node.type === "code" ? "code" as const : "paragraph" as const, text }];
    }).filter(item => item.text.trim());
    const body = blocks.map(item => item.text).join("\n\n");
    const sectionPath = headings.length ? headings.map(heading => heading.title) : ["Introduction"];
    if (body) {
      sections.push({
        source: "markdown",
        sourceId: `${document.sourceId}#section-${index++}`,
        content: body,
        blocks,
        metadata: {
          ...document.metadata,
          title: `${documentTitle} > ${sectionPath.join(" > ")}`,
          documentTitle,
          sectionPath,
        },
      });
    }
    sectionNodes = [];
  }

  for (const node of root.children ?? []) {
    if (node.type === "heading" && node.depth === 1) continue;
    if (node.type === "heading" && node.depth && node.depth >= 2) {
      flush();
      while (headings.length && headings[headings.length - 1].depth >= node.depth) headings.pop();
      headings.push({ depth: node.depth, title: cleanInline(inline(node, definitions)) });
    } else if (node.type !== "definition") {
      sectionNodes.push(node);
    }
  }
  flush();
  if (sections.length === 0) throw new Error(`${document.sourceId}: no usable markdown sections`);
  return sections;
}
