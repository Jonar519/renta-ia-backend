import { OpenApiGeneratorV3, OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z, ZodTypeAny } from "zod";
import { DocumentStatus, DocumentType } from "@prisma/client";
import { loginSchema, registerSchema } from "../modules/auth/auth.schema";
import {
  clientIdParams,
  createClientSchema,
  summarySchema,
  updateClientSchema,
} from "../modules/clients/clients.schema";
import {
  byHashParams,
  createDocumentSchema,
  documentClientParams,
  documentIdParams,
  uploadDocumentSchema,
} from "../modules/documents/documents.schema";
import { alertClientParams, alertIdParams, updateAlertStatusSchema } from "../modules/alerts/alerts.schema";
import { chatSchema } from "../modules/ai/ai.schema";
import { summaryQuerySchema, webVitalsPayloadSchema } from "../modules/metrics/metrics.schema";
import { auditQuerySchema, createUserSchema } from "../modules/admin/admin.schema";
import { paginationQuerySchema } from "../utils/pagination";

/**
 * Especificación OpenAPI 3 generada a partir de los MISMOS schemas zod que
 * validan cada ruta (src/modules/*\/*.schema.ts): si cambia la validación,
 * cambia la documentación. Las respuestas se describen aquí con zod.
 *
 *  - GET /docs (fuera de producción): Swagger UI.
 *  - docs/openapi.json: exportado con `npm run openapi`; un test verifica
 *    que esté al día (tests/unit/openapi.test.ts).
 */
extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

const bearer = registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description: "Access token de 15 min (POST /api/auth/login o /api/auth/refresh). Solo en memoria del navegador.",
});
const refreshCookie = registry.registerComponent("securitySchemes", "refreshCookie", {
  type: "apiKey",
  in: "cookie",
  name: "renta_ia_refresh",
  description:
    "Refresh token rotativo (httpOnly, SameSite=Strict, Path=/api/auth). Requiere X-Requested-With: renta-ia.",
});

// ---------- Respuestas ----------
const ErrorResponse = registry.register(
  "Error",
  z.object({
    error: z.string(),
    details: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
  })
);
const Role = z.enum(["admin", "accountant", "assistant", "client"]);
const User = registry.register(
  "User",
  z.object({ id: z.string().uuid(), name: z.string(), email: z.string().email(), role: Role })
);
const Session = registry.register(
  "Session",
  z.object({ accessToken: z.string().describe("JWT de 15 min"), user: User })
);
const Client = registry.register(
  "Client",
  z.object({
    id: z.string().uuid(),
    accountantUserId: z.string().uuid(),
    portalUserId: z.string().uuid().nullable(),
    fullName: z.string(),
    documentNumber: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    accountant: z.object({ id: z.string().uuid(), name: z.string() }).optional().describe("Solo para el admin"),
  })
);
const Document = registry.register(
  "Document",
  z.object({
    id: z.string().uuid(),
    clientId: z.string().uuid(),
    uploadedBy: z.string().uuid(),
    docType: z.nativeEnum(DocumentType),
    originalName: z.string(),
    status: z.nativeEnum(DocumentStatus),
    errorMessage: z.string().nullable().describe('Error, o advertencias si status="processed"'),
    uploadedAt: z.string().datetime(),
    processedAt: z.string().datetime().nullable(),
    sha256: z.string().nullable(),
  })
);
const Alert = registry.register(
  "Alert",
  z.object({
    id: z.string().uuid(),
    clientId: z.string().uuid(),
    documentId: z.string().uuid().nullable(),
    alertType: z.enum(["deadline", "inconsistency"]),
    severity: z.enum(["low", "medium", "high", "critical"]),
    message: z.string(),
    status: z.enum(["open", "acknowledged", "resolved"]),
    dueDate: z.string().nullable(),
    createdAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
  })
);
const TaxConcept = registry.register(
  "TaxConcept",
  z.object({
    id: z.string().uuid(),
    documentId: z.string().uuid(),
    conceptType: z.string(),
    description: z.string().nullable(),
    amount: z.string().describe("Decimal como texto"),
    periodYear: z.number().int(),
  })
);
const page = <T extends ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable().describe("null si no hay más páginas") });

const json = (schema: ZodTypeAny, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const errors = {
  400: json(ErrorResponse, "Datos inválidos"),
  401: json(ErrorResponse, "Sin sesión o token vencido"),
  403: json(ErrorResponse, "El rol no permite esta acción"),
  404: json(ErrorResponse, "No existe o no es accesible (no se revela cuál)"),
  429: json(ErrorResponse, "Límite de solicitudes"),
};
const auth = [{ [bearer.name]: [] }];

type Method = "get" | "post" | "patch" | "delete";
interface PathSpec {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  secure?: boolean;
  params?: z.AnyZodObject;
  query?: z.AnyZodObject;
  body?: ZodTypeAny;
  bodyType?: string;
  responses: Record<number, ReturnType<typeof json> | { description: string }>;
}

function route(spec: PathSpec) {
  registry.registerPath({
    method: spec.method,
    path: spec.path,
    tags: [spec.tag],
    summary: spec.summary,
    security: spec.secure === false ? [] : auth,
    request: {
      params: spec.params,
      query: spec.query,
      body: spec.body
        ? { required: true, content: { [spec.bodyType ?? "application/json"]: { schema: spec.body } } }
        : undefined,
    },
    responses: spec.responses,
  });
}

// ---------- Auth ----------
route({
  method: "post",
  path: "/api/auth/register",
  tag: "Auth",
  summary: "Registro público (siempre crea un contador). Deja la cookie de refresh.",
  secure: false,
  body: registerSchema,
  responses: {
    201: json(Session, "Sesión iniciada"),
    400: errors[400],
    409: json(ErrorResponse, "Correo ya registrado"),
    429: errors[429],
  },
});
route({
  method: "post",
  path: "/api/auth/login",
  tag: "Auth",
  summary: "Login. Bloqueo progresivo por cuenta y límite por IP. Deja la cookie de refresh.",
  secure: false,
  body: loginSchema,
  responses: { 200: json(Session, "Sesión iniciada"), 401: errors[401], 429: errors[429] },
});
for (const [path, summary, ok] of [
  [
    "/api/auth/refresh",
    "Rota el refresh token (cookie) y entrega un access token nuevo.",
    json(Session, "Sesión renovada"),
  ],
  [
    "/api/auth/logout",
    "Revoca la sesión (toda la familia de refresh tokens) y borra la cookie.",
    { description: "Sesión cerrada" },
  ],
] as const) {
  registry.registerPath({
    method: "post",
    path,
    tags: ["Auth"],
    summary,
    security: [{ [refreshCookie.name]: [] }],
    request: { headers: z.object({ "X-Requested-With": z.literal("renta-ia") }) },
    responses: {
      [path.endsWith("logout") ? 204 : 200]: ok,
      401: errors[401],
      403: json(ErrorResponse, "Falta X-Requested-With o el Origin no está permitido (CSRF)"),
      ...(path.endsWith("refresh") ? { 409: json(ErrorResponse, "Otra pestaña está renovando; reintentar") } : {}),
    },
  });
}
route({
  method: "get",
  path: "/api/users/me",
  tag: "Auth",
  summary: "Usuario actual",
  responses: { 200: json(User, "Usuario"), 401: errors[401] },
});

// ---------- Clientes ----------
route({
  method: "get",
  path: "/api/clients",
  tag: "Clientes",
  summary: "Clientes visibles para el rol (paginado por cursor)",
  query: paginationQuerySchema,
  responses: { 200: json(page(Client), "Página de clientes"), 401: errors[401] },
});
route({
  method: "post",
  path: "/api/clients",
  tag: "Clientes",
  summary: "Crear cliente (admin y accountant)",
  body: createClientSchema,
  responses: { 201: json(Client, "Creado"), 400: errors[400], 403: errors[403] },
});
route({
  method: "get",
  path: "/api/clients/{id}",
  tag: "Clientes",
  summary: "Detalle de un cliente",
  params: clientIdParams,
  responses: { 200: json(Client, "Cliente"), 404: errors[404] },
});
route({
  method: "patch",
  path: "/api/clients/{id}",
  tag: "Clientes",
  summary: "Actualizar (no el rol client)",
  params: clientIdParams,
  body: updateClientSchema,
  responses: { 200: json(Client, "Actualizado"), 400: errors[400], 403: errors[403], 404: errors[404] },
});
route({
  method: "delete",
  path: "/api/clients/{id}",
  tag: "Clientes",
  summary: "Borrar (admin y accountant)",
  params: clientIdParams,
  responses: { 204: { description: "Borrado" }, 403: errors[403], 404: errors[404] },
});
route({
  method: "get",
  path: "/api/clients/{id}/tax-concepts",
  tag: "Clientes",
  summary: "Conceptos tributarios extraídos",
  params: clientIdParams,
  responses: { 200: json(z.array(TaxConcept), "Conceptos"), 404: errors[404] },
});
route({
  method: "post",
  path: "/api/clients/{id}/summary",
  tag: "IA",
  summary: "Resumen ejecutivo (totales calculados en código + redacción del LLM)",
  params: clientIdParams,
  body: summarySchema,
  responses: {
    200: json(z.object({}).passthrough(), "Resumen con aviso de revisión profesional"),
    403: errors[403],
    404: errors[404],
    429: errors[429],
  },
});

// ---------- Documentos ----------
route({
  method: "post",
  path: "/api/documents/upload",
  tag: "Documentos",
  summary: "Subir PDF/JPG/PNG (máx. 15 MB) y encolar el análisis",
  body: uploadDocumentSchema.extend({ file: z.string().openapi({ type: "string", format: "binary" }) }),
  bodyType: "multipart/form-data",
  responses: {
    201: json(Document, "Encolado"),
    400: errors[400],
    403: errors[403],
    404: errors[404],
    409: json(ErrorResponse, "El mismo archivo ya se subió a este cliente"),
    429: errors[429],
  },
});
route({
  method: "post",
  path: "/api/documents",
  tag: "Documentos",
  summary: "Registrar metadatos de un documento ya almacenado",
  body: createDocumentSchema,
  responses: { 201: json(Document, "Creado"), 400: errors[400], 404: errors[404] },
});
route({
  method: "get",
  path: "/api/documents/client/{clientId}",
  tag: "Documentos",
  summary: "Documentos de un cliente (paginado)",
  params: documentClientParams,
  query: paginationQuerySchema,
  responses: { 200: json(page(Document), "Página de documentos"), 404: errors[404] },
});
route({
  method: "get",
  path: "/api/documents/client/{clientId}/by-hash/{sha256}",
  tag: "Documentos",
  summary: "¿Ya existe este archivo para el cliente? (antes de subir)",
  params: byHashParams,
  responses: {
    200: json(z.object({ exists: z.boolean(), document: Document.nullable() }), "Resultado"),
    404: errors[404],
  },
});
route({
  method: "get",
  path: "/api/documents/{id}",
  tag: "Documentos",
  summary: "Detalle de un documento",
  params: documentIdParams,
  responses: { 200: json(Document, "Documento"), 404: errors[404] },
});
route({
  method: "post",
  path: "/api/documents/{id}/reprocess",
  tag: "Documentos",
  summary: "Reintentar el análisis (solo si terminó en error o con advertencias)",
  params: documentIdParams,
  responses: {
    202: json(Document, "Reencolado"),
    404: errors[404],
    409: json(ErrorResponse, "Ya está en cola o procesándose"),
  },
});

// ---------- Alertas ----------
route({
  method: "get",
  path: "/api/alerts/client/{clientId}",
  tag: "Alertas",
  summary: "Alertas de un cliente (paginado)",
  params: alertClientParams,
  query: paginationQuerySchema,
  responses: { 200: json(page(Alert), "Página de alertas"), 404: errors[404] },
});
route({
  method: "patch",
  path: "/api/alerts/{id}",
  tag: "Alertas",
  summary: "Marcar como vista o resuelta (no el rol client)",
  params: alertIdParams,
  body: updateAlertStatusSchema,
  responses: { 200: json(Alert, "Actualizada"), 403: errors[403], 404: errors[404] },
});
route({
  method: "post",
  path: "/api/alerts/deadlines/run",
  tag: "Alertas",
  summary: "Ejecutar ya la revisión de vencimientos (admin)",
  responses: { 200: json(z.object({}).passthrough(), "Resultado"), 403: errors[403] },
});

// ---------- IA ----------
route({
  method: "post",
  path: "/api/ai/chat",
  tag: "IA",
  summary: "Pregunta sobre los documentos de UN cliente (RAG aislado por cliente)",
  body: chatSchema,
  responses: {
    200: json(
      z.object({ conversationId: z.string().uuid(), answer: z.string(), sources: z.number().int() }),
      "Respuesta"
    ),
    403: errors[403],
    404: errors[404],
    429: errors[429],
  },
});

// ---------- Métricas web ----------
route({
  method: "post",
  path: "/api/metrics/web-vitals",
  tag: "Métricas",
  summary: "Beacon anónimo de Web Vitals (text/plain con JSON)",
  secure: false,
  body: webVitalsPayloadSchema,
  bodyType: "text/plain",
  responses: { 204: { description: "Registrado" }, 400: errors[400], 429: errors[429] },
});
route({
  method: "get",
  path: "/api/metrics/web-vitals/summary",
  tag: "Métricas",
  summary: "p75 por métrica y ruta (admin)",
  query: summaryQuerySchema,
  responses: { 200: json(z.object({}).passthrough(), "Resumen"), 403: errors[403] },
});

// ---------- Admin ----------
route({
  method: "post",
  path: "/api/admin/users",
  tag: "Admin",
  summary: "Crear usuario assistant (ligado a un contador) o client (ligado a un expediente)",
  body: createUserSchema,
  responses: {
    201: json(User, "Creado"),
    400: errors[400],
    403: errors[403],
    409: json(ErrorResponse, "Correo o expediente ya en uso"),
  },
});
route({
  method: "get",
  path: "/api/admin/audit",
  tag: "Admin",
  summary: "Registro de auditoría (filtrable, paginado por id)",
  query: auditQuerySchema,
  responses: {
    200: json(
      z.object({ items: z.array(z.object({}).passthrough()), nextCursor: z.string().nullable() }),
      "Página de auditoría"
    ),
    403: errors[403],
  },
});

// ---------- Operación ----------
route({
  method: "get",
  path: "/health",
  tag: "Operación",
  summary: "Liveness (no consulta dependencias)",
  secure: false,
  responses: { 200: json(z.object({ status: z.literal("ok"), uptimeSeconds: z.number() }), "Vivo") },
});
route({
  method: "get",
  path: "/ready",
  tag: "Operación",
  summary: "Readiness: PostgreSQL y Redis; 503 durante el apagado",
  secure: false,
  responses: {
    200: json(z.object({ status: z.string(), checks: z.record(z.string()) }), "Listo"),
    503: json(z.object({ status: z.string(), checks: z.record(z.string()).optional() }), "No listo"),
  },
});
route({
  method: "get",
  path: "/metrics",
  tag: "Operación",
  summary: "Métricas Prometheus (Authorization: Bearer METRICS_TOKEN; 404 si no está configurado)",
  secure: false,
  responses: {
    200: { description: "Formato de exposición de Prometheus (text/plain)" },
    401: { description: "Token inválido" },
    404: { description: "Métricas desactivadas" },
  },
});

export function buildOpenApiDocument() {
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Renta IA — API",
      version: "0.2.0",
      description:
        "API del Sistema de Gestión Documental Contable con IA. Generada desde los schemas zod de validación (src/docs/openapi.ts).",
    },
    servers: [{ url: "http://localhost:4000", description: "Desarrollo" }],
  });
}
