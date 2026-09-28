import { Request, Response } from "express";
import { ragService } from "./rag.service";
import { audit } from "../../services/audit/audit.service";

export const aiController = {
  // clientId y question ya vienen validados por chatSchema (ai.schema.ts).
  async chat(req: Request, res: Response) {
    const { clientId, question } = req.body;

    const result = await ragService.askQuestion({
      clientId,
      userId: req.user!.userId,
      question,
    });

    // Sin el texto de la pregunta: solo quién consultó sobre qué cliente.
    audit(req, { action: "ai.chat", entity: "client", entityId: clientId });
    res.json(result);
  },
};
