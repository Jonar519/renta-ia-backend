import { Request, Response } from "express";
import { authService } from "./auth.service";

export const authController = {
  async register(req: Request, res: Response) {
    const result = await authService.register(req.body);
    res.status(201).json(result);
  },

  async login(req: Request, res: Response) {
    const result = await authService.login(req.body);
    res.status(200).json(result);
  },
};
