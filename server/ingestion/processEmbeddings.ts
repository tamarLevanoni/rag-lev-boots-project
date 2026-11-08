import "dotenv/config";
import { QueryTypes } from "sequelize";
import sequelize from "../config/database";
import { createEmbedding, EMBEDDING_DIMENSIONS } from "../services/gemini-service";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function embedWithRetry(text: string): Promise<number[]> {
  for (let attempt = 0; ; attempt++) {
    try { return await createEmbedding(text); }
    catch (error) {
      const status = (error as { status?: number; code?: number }).status ?? (error as { code?: number }).code;
      if (attempt >= 5 || ![429, 500, 502, 503, 504].includes(status ?? 0)) throw error;
      const delay = Math.min(2000 * 2 ** attempt, 60000);
      console.log(`Embedding HTTP ${status}; retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}

async function main() {
  await sequelize.authenticate();
  const pending = await sequelize.query<{ id: number; chunk_content: string }>(
    `SELECT id, chunk_content FROM public.knowledge_base
     WHERE embeddings_768 IS NULL ORDER BY id`,
    { type: QueryTypes.SELECT }
  );
  console.log(`Pending chunks: ${pending.length}`);
  for (const [index, chunk] of pending.entries()) {
    // This is exactly the text stored and later passed to the answering model.
    const embedding = await embedWithRetry(chunk.chunk_content);
    if (embedding.length !== EMBEDDING_DIMENSIONS || !embedding.every(Number.isFinite) || !embedding.some(value => value !== 0)) throw new Error("Invalid embedding vector");
    const updated = await sequelize.query<{ id: number }>(
      `UPDATE public.knowledge_base SET embeddings_768 = CAST(:embedding AS public.vector), updated_at = NOW()
       WHERE id = :id AND chunk_content = :content AND embeddings_768 IS NULL RETURNING id`,
      { replacements: { embedding: JSON.stringify(embedding), id: chunk.id, content: chunk.chunk_content }, type: QueryTypes.SELECT }
    );
    if (updated.length !== 1) throw new Error("Chunk changed during embedding; rerun the worker");
    console.log(`[${index + 1}/${pending.length}] Embedded chunk ${chunk.id}`);
    await sleep(1500);
  }
}
main().catch(error => { console.error("Embedding stopped; rerun to resume pending chunks:", error); process.exitCode = 1; }).finally(async () => { await sequelize.close(); });
