import { Request, Response } from "express";
import { ragService } from "./rag.service";
import { ApiError } from "../../utils/apiError";

export const aiController = {
  async chat(req: Request, res: Response) {
    const { clientId, question } = req.body;

    if (!clientId || !question) {
      throw new ApiError(400, "clientId y question son requeridos");
    }

    const result = await ragService.askQuestion({
      clientId,
      userId: req.user!.userId,
      question,
    });

    res.json(result);
  },
};
