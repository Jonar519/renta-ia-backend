import { z } from "zod";
import { uuidParams } from "../../utils/schemas";

export const alertClientParams = uuidParams("clientId");
export const alertIdParams = uuidParams("id");

export const updateAlertStatusSchema = z.object({
  status: z.enum(["acknowledged", "resolved"], {
    errorMap: () => ({ message: 'status debe ser "acknowledged" o "resolved"' }),
  }),
});
