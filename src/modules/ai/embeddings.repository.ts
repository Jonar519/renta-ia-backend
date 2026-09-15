import { prisma } from "../../config/prisma";

/**
 * La columna `embedding` es de tipo `vector(1024)` (extensión pgvector).
 * Prisma Client no modela nativamente ese tipo (queda como "Unsupported"
 * en schema.prisma), así que aquí se usa SQL crudo con $executeRaw /
 * $queryRaw. Prisma sigue parametrizando estas consultas de forma segura
 * (previene inyección SQL), solo que nosotros escribimos el SQL a mano.
 */

export async function saveEmbedding(
  documentId: string,
  chunkIndex: number,
  chunkText: string,
  embedding: number[]
): Promise<void> {
  const vectorLiteral = `[${embedding.join(",")}]`;

  await prisma.$executeRaw`
    INSERT INTO document_embeddings (document_id, chunk_index, chunk_text, embedding)
    VALUES (${documentId}::uuid, ${chunkIndex}, ${chunkText}, ${vectorLiteral}::vector)
  `;
}

export interface SimilarChunk {
  documentId: string;
  chunkText: string;
  distance: number;
}

export async function searchSimilarChunks(
  clientId: string,
  queryEmbedding: number[],
  limit = 5
): Promise<SimilarChunk[]> {
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  return prisma.$queryRaw<SimilarChunk[]>`
    SELECT de.document_id AS "documentId",
           de.chunk_text  AS "chunkText",
           de.embedding <=> ${vectorLiteral}::vector AS distance
    FROM document_embeddings de
    JOIN documents d ON d.id = de.document_id
    WHERE d.client_id = ${clientId}::uuid
    ORDER BY de.embedding <=> ${vectorLiteral}::vector
    LIMIT ${limit}
  `;
}
