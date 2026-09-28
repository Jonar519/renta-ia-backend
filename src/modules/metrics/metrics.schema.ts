import { z } from "zod";

export const METRICS = ["LCP", "INP", "CLS", "TTFB", "FCP", "FID", "LONG_TASK", "LOAF"] as const;

const entry = z
  .object({
    name: z.enum(METRICS),
    // ms para todas salvo CLS (adimensional). Tope generoso contra valores basura.
    value: z.number().finite().min(0).max(120_000),
    rating: z.enum(["good", "needs-improvement", "poor"]).optional(),
    // Ruta NORMALIZADA ("/clients/:id"): nunca ids, correos ni query strings.
    route: z.string().regex(/^\/[a-z0-9/:_-]{0,80}$/i, { message: "Ruta normalizada inválida" }),
    navigationType: z.string().max(20).optional(),
    attribution: z.string().max(200).optional(),
  })
  .refine((e) => e.name !== "CLS" || e.value <= 10, { message: "CLS fuera de rango", path: ["value"] });

/**
 * Payload del beacon (navigator.sendBeacon). Llega como text/plain (tipo
 * "simple": no dispara preflight CORS) con un JSON adentro.
 */
export const webVitalsPayloadSchema = z.object({
  device: z.enum(["mobile", "tablet", "desktop"]),
  entries: z.array(entry).min(1).max(50),
});

export const summaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  device: z.enum(["mobile", "tablet", "desktop"]).optional(),
});
