import { Op } from "sequelize";
import KnowledgeBase from "../models/KnowledgeBase";
import sequelize from "../config/database";
import type { DocumentChunk } from "./chunker";

export async function saveChunks(chunks: DocumentChunk[]): Promise<void> {
  if (!chunks.length) throw new Error("No chunks to save");

  await sequelize.transaction(async transaction => {
    await sequelize.query("LOCK TABLE public.knowledge_base IN SHARE ROW EXCLUSIVE MODE", { transaction });
    const sources = [...new Set(chunks.map(chunk => chunk.source))];
    const existing = await KnowledgeBase.findAll({
      where: { source: { [Op.in]: sources } },
      order: [["id", "ASC"]],
      transaction,
    });
    const identity = (source: string, sourceId: string, index: number) => JSON.stringify([source, sourceId, index]);
    const byIdentity = new Map(existing.map(row => [identity(row.source, row.source_id, row.chunk_index), row]));
    const savedIds: number[] = [];
    let inserted = 0;
    let updated = 0;

    for (const chunk of chunks) {
      const record = byIdentity.get(identity(chunk.source, chunk.sourceId, chunk.chunkIndex));
      if (record) {
        if (record.chunk_content !== chunk.content) {
          // A vector describes specific text; changing that text invalidates it.
          await record.update({ chunk_content: chunk.content, embeddings_768: null, embeddings_1536: null }, { transaction });
          updated++;
        }
        savedIds.push(record.id);
      } else {
        const created = await KnowledgeBase.create({
          source: chunk.source,
          source_id: chunk.sourceId,
          chunk_index: chunk.chunkIndex,
          chunk_content: chunk.content,
          embeddings_768: null,
          embeddings_1536: null,
        }, { transaction });
        savedIds.push(created.id);
        inserted++;
      }
    }

    // Remove obsolete sections/chunks and duplicate rows from these sources.
    const removed = await KnowledgeBase.destroy({
      where: { source: { [Op.in]: sources }, id: { [Op.notIn]: savedIds } }, transaction,
    });
    console.log(`Chunks: ${chunks.length}; inserted: ${inserted}; changed: ${updated}; removed: ${removed}`);
  });
}
