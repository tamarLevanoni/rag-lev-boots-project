import { GoogleGenAI } from "@google/genai";
import "dotenv/config";

const gemini = new GoogleGenAI({});
export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

export async function askGemini(model: string, userPrompt: string, systemPrompt: string) {
  return gemini.models.generateContent({
    model,
    contents: userPrompt,
    config: { systemInstruction: systemPrompt },
  });
}

// Documents and questions must use the same model, dimensions and normalization.
async function embedText(text: string, taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"): Promise<number[]> {
  if (!text.trim()) throw new Error("Cannot embed empty text");

  const result = await gemini.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
    config: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType },
  });
  const embedding = result.embeddings?.[0]?.values;
  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS || !embedding.every(Number.isFinite)) {
    throw new Error("Invalid embedding vector");
  }
  const magnitude = Math.hypot(...embedding);
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error("Invalid embedding magnitude");
  return embedding.map(value => value / magnitude);
}

export function createEmbedding(text: string): Promise<number[]> {
  return embedText(text, "RETRIEVAL_DOCUMENT");
}

export function createQueryEmbedding(question: string): Promise<number[]> {
  return embedText(question, "RETRIEVAL_QUERY");
}
