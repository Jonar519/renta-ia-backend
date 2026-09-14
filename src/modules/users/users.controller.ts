import { Request, Response } from "express";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";

export const usersController = {
  async me(req: Request, res: Response) {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) {
      throw new ApiError(404, "Usuario no encontrado");
    }
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  },
};
