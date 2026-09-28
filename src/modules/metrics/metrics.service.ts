import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../config/prisma";
import { webVitalsPayloadSchema } from "./metrics.schema";

export type WebVitalsPayload = z.infer<typeof webVitalsPayloadSchema>;

export interface VitalSummaryRow {
  metric: string;
  /** null = todas las rutas */
  route: string | null;
  samples: number;
  p75: number;
}

export const WEB_VITALS_RETENTION_DAYS = 90;

export const metricsService = {
  async record(payload: WebVitalsPayload) {
    await prisma.webVital.createMany({
      data: payload.entries.map((e) => ({
        metric: e.name,
        value: e.value,
        rating: e.rating,
        route: e.route,
        device: payload.device,
        navigationType: e.navigationType,
        attribution: e.attribution,
      })),
    });
  },

  /**
   * p75 por métrica y ruta (y el total por métrica, route = null) en los
   * últimos `days` días. p75 es el percentil que usa Google para evaluar las
   * Core Web Vitals: el 75% de las visitas fue igual o mejor que ese valor.
   */
  async summary(days: number, device?: string): Promise<VitalSummaryRow[]> {
    const deviceFilter = device ? Prisma.sql`AND device = ${device}` : Prisma.empty;
    const rows = await prisma.$queryRaw<{ metric: string; route: string | null; samples: number; p75: number }[]>`
      SELECT metric,
             route,
             count(*)::int AS samples,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY value) AS p75
      FROM web_vitals
      WHERE created_at >= now() - make_interval(days => ${days}::int) ${deviceFilter}
      GROUP BY GROUPING SETS ((metric, route), (metric))
      ORDER BY metric, route NULLS FIRST
    `;
    return rows.map((r) => ({ ...r, p75: Math.round(Number(r.p75) * 1000) / 1000 }));
  },

  /** Borra muestras más antiguas que la retención (job diario). */
  async purgeOld(): Promise<number> {
    const { count } = await prisma.webVital.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - WEB_VITALS_RETENTION_DAYS * 24 * 60 * 60 * 1000) } },
    });
    return count;
  },
};
