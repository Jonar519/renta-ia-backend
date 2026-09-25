import { Request, Response } from "express";
import { ragService } from "./rag.service";

export const aiController = {
  // clientId y question ya vienen validados por chatSchema (ai.schema.ts).
  async chat(req: Request, res: Response) {
    const { clientId, question } = req.body;

    const result = await ragService.askQuestion({
      clientId,
      userId: req.user!.userId,
      question,
    });

    res.json(result);
  },
};
