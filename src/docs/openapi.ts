import { OpenApiGeneratorV3, OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z, ZodTypeAny } from "zod";
import { DocumentStatus, DocumentType } from "@prisma/client";
import {
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  passwordResetTokenSchema,
} from "../modules/auth/auth.schema";
import {
  acceptInvitationSchema,
  invitationTokenSchema,
  invitedUserParams,
  inviteSchema,
} from "../modules/invitations/invitations.schema";
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
import { auditQuerySchema, portalClientsQuerySchema } from "../modules/admin/admin.schema";
import {
  loginMfaSchema,
  mfaDisableSchema,
  mfaEnableSchema,
  mfaRegenerateSchema,
  mfaSetupSchema,
  mfaUserParams,
} from "../modules/mfa/mfa.schema";
import {
  changePasswordSchema,
  emailChangeConfirmSchema,
  emailChangeSchema,
  deleteAccountSchema,
  exportDataSchema,
  sessionParams,
  updateProfileSchema,
} from "../modules/users/profile.schema";
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
    code: z.string().optional().describe("Identificador estable: mfa_enrollment_required, mfa_challenge_invalid"),
  })
);
const Role = z.enum(["admin", "accountant", "assistant", "client"]);
const User = registry.register(
  "User",
  z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
    role: Role,
    mfaEnabled: z.boolean().describe("Si es false y el rol lo exige (admin), solo puede activarlo"),
    avatarUpdatedAt: z.string().datetime().nullable().describe("null = sin foto de perfil"),
  })
);
const Invitation = registry.register(
  "Invitation",
  z
    .object({
      userId: z.string().uuid(),
      name: z.string(),
      email: z.string().email(),
      role: Role,
      status: z.enum(["pending", "expired"]),
      invitedAt: z.string().datetime(),
      expiresAt: z.string().datetime().nullable(),
      accountant: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
      client: z.object({ id: z.string().uuid(), fullName: z.string() }).nullable(),
    })
    .describe("Cuenta pendiente y su invitación. NUNCA incluye el token ni el enlace: solo viajan por correo.")
);
const PendingEmail = z.object({ email: z.string().email(), expiresAt: z.string().datetime() });
const Profile = registry.register(
  "Profile",
  z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
    role: Role,
    phone: z.string().nullable(),
    mfaEnabled: z.boolean(),
    avatarUpdatedAt: z.string().datetime().nullable().describe("null = sin foto"),
    pendingEmail: PendingEmail.nullable().describe("Cambio de correo esperando confirmación"),
  })
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
// Toda ruta autenticada fuera de /api/users/me(/mfa) puede responder esto a un admin sin MFA.
errors[403] = json(
  ErrorResponse,
  "El rol no permite esta acción, o (code: mfa_enrollment_required) un admin debe activar MFA primero"
);

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
  path: "/api/auth/login",
  tag: "Auth",
  summary: "Login. Bloqueo progresivo por cuenta y límite por IP. Deja la cookie de refresh.",
  secure: false,
  body: loginSchema,
  responses: {
    200: json(
      z.union([
        Session,
        z
          .object({
            mfaRequired: z.literal(true),
            challengeToken: z.string(),
            expiresAt: z.string().datetime(),
          })
          .describe("Cuenta con MFA activo: todavía SIN sesión ni cookie. Continuar en POST /api/auth/login/mfa."),
      ]),
      "Sesión iniciada, o paso de verificación si la cuenta tiene MFA"
    ),
    401: errors[401],
    429: errors[429],
    503: json(ErrorResponse, "Cuenta con MFA y servidor sin MFA_ENCRYPTION_KEY"),
  },
});
route({
  method: "post",
  path: "/api/auth/login/mfa",
  tag: "Auth",
  summary:
    "Segundo paso del login: código de 6 dígitos de la app o un código de recuperación. Paso de 5 min y 5 intentos; deja la cookie de refresh.",
  secure: false,
  body: loginMfaSchema,
  responses: {
    200: json(Session, "Sesión iniciada"),
    400: errors[400],
    401: json(ErrorResponse, "Código incorrecto, o paso vencido, usado o agotado"),
    429: errors[429],
  },
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
  method: "post",
  path: "/api/auth/invitations/lookup",
  tag: "Auth",
  summary:
    "Completa tu cuenta: a quién corresponde un enlace de invitación vigente (token en el cuerpo, nunca en la URL)",
  secure: false,
  body: invitationTokenSchema,
  responses: {
    200: json(
      z.object({
        name: z.string(),
        email: z.string().email(),
        role: Role,
        expiresAt: z.string().datetime(),
        mfaRequired: z.boolean(),
      }),
      "Invitación vigente"
    ),
    400: errors[400],
    410: json(ErrorResponse, "Enlace inválido, vencido, reemplazado o ya usado (no se revela cuál)"),
    429: errors[429],
  },
});
route({
  method: "post",
  path: "/api/auth/invitations/accept",
  tag: "Auth",
  summary:
    "Activa la cuenta invitada con la contraseña elegida por la persona (un solo uso). Deja la cookie de refresh.",
  secure: false,
  body: acceptInvitationSchema,
  responses: {
    200: json(Session, "Cuenta activada y sesión iniciada"),
    400: errors[400],
    410: json(ErrorResponse, "Enlace inválido, vencido, reemplazado o ya usado"),
    429: errors[429],
  },
});
route({
  method: "post",
  path: "/api/auth/password-reset/request",
  tag: "Auth",
  summary:
    "Pedir un enlace para restablecer la contraseña. Responde SIEMPRE lo mismo (y en el mismo tiempo), exista o no el correo",
  secure: false,
  body: passwordResetRequestSchema,
  responses: { 202: json(z.object({ message: z.string() }), "Recibido"), 400: errors[400], 429: errors[429] },
});
route({
  method: "post",
  path: "/api/auth/password-reset/lookup",
  tag: "Auth",
  summary: "¿Sigue vigente un enlace de recuperación? (token en el cuerpo)",
  secure: false,
  body: passwordResetTokenSchema,
  responses: {
    200: json(z.object({ expiresAt: z.string().datetime() }), "Vigente"),
    410: json(ErrorResponse, "Inválido, vencido, reemplazado o ya usado"),
    429: errors[429],
  },
});
route({
  method: "post",
  path: "/api/auth/password-reset/confirm",
  tag: "Auth",
  summary: "Define la contraseña nueva (un solo uso) y cierra TODAS las sesiones de la cuenta",
  secure: false,
  body: passwordResetConfirmSchema,
  responses: {
    204: { description: "Contraseña cambiada; hay que iniciar sesión de nuevo" },
    400: errors[400],
    410: json(ErrorResponse, "Inválido, vencido, reemplazado o ya usado"),
    429: errors[429],
  },
});
route({
  method: "get",
  path: "/api/users/me",
  tag: "Perfil",
  summary: "La propia cuenta: datos, teléfono y cambio de correo pendiente",
  responses: { 200: json(Profile, "Perfil"), 401: errors[401] },
});
route({
  method: "patch",
  path: "/api/users/me",
  tag: "Perfil",
  summary: "Editar nombre y/o teléfono ('' o null borra el teléfono). Rol y correo no se editan aquí.",
  body: updateProfileSchema,
  responses: { 200: json(Profile, "Perfil actualizado"), 400: errors[400], 401: errors[401] },
});
route({
  method: "post",
  path: "/api/users/me/email",
  tag: "Perfil",
  summary:
    "Pedir cambio de correo (con la contraseña actual): enlace de 24 h al correo NUEVO y aviso al anterior. Responde igual aunque el nuevo ya tenga cuenta.",
  body: emailChangeSchema,
  responses: {
    202: json(z.object({ pendingEmail: PendingEmail }), "Enlace enviado; el correo cambia al confirmarlo"),
    400: json(ErrorResponse, "Datos inválidos, mismo correo o contraseña incorrecta"),
    401: errors[401],
    429: json(ErrorResponse, "Límite de intentos o cuenta bloqueada por intentos fallidos"),
  },
});
route({
  method: "delete",
  path: "/api/users/me/email",
  tag: "Perfil",
  summary: "Cancelar el cambio de correo pendiente",
  responses: {
    204: { description: "Cancelado" },
    401: errors[401],
    404: json(ErrorResponse, "No hay cambio pendiente"),
  },
});
route({
  method: "post",
  path: "/api/users/me/password",
  tag: "Perfil",
  summary: "Cambiar la contraseña (con la actual): aplica la política y cierra TODAS las demás sesiones",
  body: changePasswordSchema,
  responses: {
    200: json(z.object({ closedSessions: z.number().int() }), "Contraseña cambiada"),
    400: json(ErrorResponse, "Contraseña actual incorrecta o la nueva no cumple la política"),
    401: errors[401],
    429: json(ErrorResponse, "Límite de intentos o cuenta bloqueada por intentos fallidos"),
  },
});
route({
  method: "post",
  path: "/api/users/me/avatar",
  tag: "Perfil",
  summary:
    "Subir o cambiar la foto (multipart, campo avatar): PNG o JPG verificados por su firma real, máx. 512 KB. Se guarda sin metadatos (EXIF, GPS, ICC, textos). Borra la anterior.",
  body: z.object({ avatar: z.string().openapi({ format: "binary" }) }),
  bodyType: "multipart/form-data",
  responses: {
    201: json(z.object({ avatarUpdatedAt: z.string().datetime() }), "Foto guardada"),
    400: json(ErrorResponse, "Falta el archivo"),
    401: errors[401],
    413: json(ErrorResponse, "Supera 512 KB"),
    415: json(ErrorResponse, "No es una imagen PNG o JPG (por su contenido)"),
    422: json(ErrorResponse, "La imagen no se puede analizar (truncada o malformada): no se guarda"),
    429: errors[429],
  },
});
route({
  method: "get",
  path: "/api/users/me/avatar",
  tag: "Perfil",
  summary: "La foto de la propia cuenta (image/png o image/jpeg; CSP default-src 'none'; sandbox)",
  responses: {
    200: { description: "La imagen (image/png o image/jpeg, según su firma)" },
    401: errors[401],
    404: json(ErrorResponse, "Sin foto"),
  },
});
route({
  method: "delete",
  path: "/api/users/me/avatar",
  tag: "Perfil",
  summary: "Quitar la foto (borra el archivo)",
  responses: { 204: { description: "Quitada" }, 401: errors[401], 404: json(ErrorResponse, "Sin foto") },
});
// ---------- Sesiones activas (B13) ----------
const ActiveSession = z.object({
  id: z.string().uuid(),
  current: z.boolean().openapi({ description: "Es la sesión de este access token" }),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().openapi({ description: "Última renovación del token" }),
  ip: z.string().nullable().openapi({ description: "Recortada: 181.49.12.x o 2001:db8:85a3::/48; null = desconocida" }),
  location: z.string().nullable().openapi({ description: "Ubicación APROXIMADA por IP; null = desconocida" }),
  device: z.string().nullable().openapi({ description: "Navegador en sistema; null = desconocido" }),
});
route({
  method: "get",
  path: "/api/users/me/sessions",
  tag: "Perfil",
  summary: "Sesiones activas de la propia cuenta (la actual primero). Las anteriores a B13 no tienen IP ni ubicación.",
  responses: { 200: json(z.array(ActiveSession), "Sesiones activas"), 401: errors[401] },
});
route({
  method: "delete",
  path: "/api/users/me/sessions/{sessionId}",
  tag: "Perfil",
  summary: "Cerrar una sesión de la propia cuenta (no la actual). Efecto inmediato, también en el WebSocket.",
  params: sessionParams,
  responses: {
    204: { description: "Cerrada" },
    400: json(ErrorResponse, "Es la sesión actual (usa Salir) o el id no es un UUID"),
    401: errors[401],
    404: json(ErrorResponse, "No existe, es de otra cuenta o ya estaba cerrada"),
  },
});
route({
  method: "delete",
  path: "/api/users/me/sessions",
  tag: "Perfil",
  summary: "Cerrar todas las demás sesiones de la propia cuenta (la actual sigue abierta)",
  responses: { 200: json(z.object({ closed: z.number().int() }), "Cuántas se cerraron"), 401: errors[401] },
});
// ---------- Exportar y eliminar la cuenta (B14) ----------
route({
  method: "post",
  path: "/api/users/me/export",
  tag: "Perfil",
  summary:
    "Descargar mis datos (JSON, adjunto). Pide la contraseña. Incluye cuenta, sesiones, actividad, conversaciones con la IA y documentos subidos (sin archivos); de los clientes a cargo, solo cuántos.",
  body: exportDataSchema,
  responses: {
    200: { description: "renta-ia-export-v1 (Content-Disposition: attachment)" },
    400: json(ErrorResponse, "Contraseña incorrecta"),
    401: errors[401],
    429: errors[429],
  },
});
route({
  method: "get",
  path: "/api/users/me/deletion",
  tag: "Perfil",
  summary: "¿Se puede eliminar la cuenta? Si no, por qué (contador con clientes, único admin).",
  responses: {
    200: json(z.object({ canDelete: z.boolean(), reason: z.string().nullable() }), "Estado"),
    401: errors[401],
  },
});
route({
  method: "post",
  path: "/api/users/me/deletion",
  tag: "Perfil",
  summary:
    "Eliminar mi cuenta (irreversible). Contraseña y, con MFA, un código. Queda una lápida anónima; se cierran todas las sesiones. Ver docs/data-retention.md.",
  body: deleteAccountSchema,
  responses: {
    204: { description: "Eliminada; borra la cookie de sesión" },
    400: json(ErrorResponse, "Contraseña o código incorrectos, o falta el código"),
    401: errors[401],
    409: json(ErrorResponse, "Contador con clientes a cargo o único administrador activo"),
    429: errors[429],
  },
});
route({
  method: "post",
  path: "/api/auth/email-change/confirm",
  tag: "Perfil",
  summary: "Confirmar el correo nuevo desde el enlace (token en el cuerpo; no exige sesión). Avisa al correo anterior.",
  secure: false,
  body: emailChangeConfirmSchema,
  responses: {
    200: json(z.object({ email: z.string().email() }), "Correo cambiado"),
    409: json(ErrorResponse, "Otra cuenta tomó ese correo mientras tanto"),
    410: json(ErrorResponse, "Enlace inválido, vencido, reemplazado o ya usado"),
    429: errors[429],
  },
});

// ---------- MFA de la propia cuenta ----------
const RecoveryCodes = z
  .object({ recoveryCodes: z.array(z.string()).length(10) })
  .describe("Se muestran UNA sola vez (Cache-Control: no-store); en la base solo queda su hash.");
const mfaErrors = {
  400: json(ErrorResponse, "Datos inválidos, contraseña o código incorrectos"),
  401: errors[401],
  429: json(ErrorResponse, "Límite de intentos o cuenta bloqueada por intentos fallidos"),
  503: json(ErrorResponse, "Servidor sin MFA_ENCRYPTION_KEY"),
};
route({
  method: "get",
  path: "/api/users/me/mfa",
  tag: "MFA",
  summary: "Estado de la verificación en dos pasos",
  responses: {
    200: json(
      z.object({
        enabled: z.boolean(),
        enabledAt: z.string().datetime().nullable(),
        recoveryCodesRemaining: z.number().int(),
        required: z.boolean().describe("El rol exige MFA (admin): no se puede desactivar"),
      }),
      "Estado"
    ),
    401: errors[401],
  },
});
route({
  method: "post",
  path: "/api/users/me/mfa/setup",
  tag: "MFA",
  summary: "Paso 1: con la contraseña actual, genera el secreto (guardado cifrado, sin activar; vence en 10 min)",
  body: mfaSetupSchema,
  responses: {
    201: json(
      z.object({
        secret: z.string().describe("Base32, para escribirlo a mano en la app"),
        otpauthUri: z.string().describe("otpauth://totp/… (contenido del QR)"),
        qrSvg: z
          .string()
          .describe("QR de otpauthUri en SVG, generado en el servidor (se muestra como imagen data:image/svg+xml)"),
        expiresAt: z.string().datetime(),
      }),
      "Secreto para la app de autenticación"
    ),
    ...mfaErrors,
    409: json(ErrorResponse, "MFA ya está activo"),
  },
});
route({
  method: "post",
  path: "/api/users/me/mfa/enable",
  tag: "MFA",
  summary:
    "Paso 2: confirma con un código; activa MFA, entrega los códigos de recuperación y cierra las DEMÁS sesiones",
  body: mfaEnableSchema,
  responses: {
    200: json(RecoveryCodes, "MFA activo"),
    ...mfaErrors,
    409: json(ErrorResponse, "Ya estaba activo"),
    410: json(ErrorResponse, "La configuración venció o no se empezó"),
  },
});
route({
  method: "post",
  path: "/api/users/me/mfa/disable",
  tag: "MFA",
  summary: "Desactiva MFA: contraseña actual + código de la app o de recuperación",
  body: mfaDisableSchema,
  responses: { 204: { description: "Desactivado" }, ...mfaErrors, 409: json(ErrorResponse, "No estaba activo") },
});
route({
  method: "post",
  path: "/api/users/me/mfa/recovery-codes",
  tag: "MFA",
  summary: "Códigos de recuperación nuevos (invalida los anteriores). Pide un código de la app.",
  body: mfaRegenerateSchema,
  responses: { 200: json(RecoveryCodes, "Códigos nuevos"), ...mfaErrors, 409: json(ErrorResponse, "MFA no activo") },
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
  path: "/api/admin/invitations",
  tag: "Admin",
  summary: "Invitar (nombre, correo, rol). Crea la cuenta pendiente y envía el enlace por correo; sin contraseña",
  body: inviteSchema,
  responses: {
    201: json(Invitation, "Invitación creada y enviada"),
    400: errors[400],
    403: errors[403],
    409: json(ErrorResponse, "Correo con cuenta activa o invitación pendiente; expediente con portal"),
    502: json(ErrorResponse, "Invitación creada pero el correo no se pudo enviar (usar Reenviar)"),
  },
});
route({
  method: "get",
  path: "/api/admin/invitations",
  tag: "Admin",
  summary: "Cuentas pendientes con el estado y el vencimiento de su invitación",
  responses: { 200: json(z.object({ items: z.array(Invitation) }), "Invitaciones"), 403: errors[403] },
});
route({
  method: "post",
  path: "/api/admin/invitations/{userId}/resend",
  tag: "Admin",
  summary: "Reenviar: invalida el enlace anterior y envía uno nuevo de 72 h",
  params: invitedUserParams,
  responses: {
    200: json(Invitation, "Reenviada"),
    403: errors[403],
    404: errors[404],
    502: json(ErrorResponse, "El correo no se pudo enviar"),
  },
});
route({
  method: "delete",
  path: "/api/admin/invitations/{userId}",
  tag: "Admin",
  summary: "Cancelar: elimina la cuenta pendiente (nunca una activa) y su enlace",
  params: invitedUserParams,
  responses: { 204: { description: "Cancelada" }, 403: errors[403], 404: errors[404] },
});
route({
  method: "delete",
  path: "/api/admin/users/{userId}/mfa",
  tag: "Admin",
  summary: "Restablece el MFA de OTRA cuenta (perdió el teléfono y los códigos): lo borra y cierra todas sus sesiones",
  params: mfaUserParams,
  responses: {
    204: { description: "MFA restablecido; la persona entra con su contraseña y lo configura de nuevo" },
    403: json(ErrorResponse, "No es admin, o intenta restablecer su propio MFA"),
    404: json(ErrorResponse, "Esa cuenta no tiene MFA activo"),
  },
});
route({
  method: "get",
  path: "/api/admin/accountants",
  tag: "Admin",
  summary: "Contadores activos (para ligar un asistente al invitarlo)",
  responses: {
    200: json(
      z.object({ items: z.array(z.object({ id: z.string().uuid(), name: z.string(), email: z.string().email() })) }),
      "Contadores"
    ),
    403: errors[403],
  },
});
route({
  method: "get",
  path: "/api/admin/portal-clients",
  tag: "Admin",
  summary: "Expedientes sin usuario de portal, por nombre o documento (máx. 20)",
  query: portalClientsQuerySchema,
  responses: {
    200: json(
      z.object({
        items: z.array(
          z.object({
            id: z.string().uuid(),
            fullName: z.string(),
            documentNumber: z.string(),
            accountant: z.object({ name: z.string() }),
          })
        ),
      }),
      "Expedientes"
    ),
    403: errors[403],
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
