// Crea los datos SINTÉTICOS que usan los escenarios (usuarios, clientes) a
// través de la propia API, y guarda lo necesario en loadtests/.state.json.
// Usar SOLO contra una base de pruebas (p. ej. renta_ia_e2e), nunca la real.
//
// No hay registro público (Fase 5): cada cuenta la invita el admin del seed,
// el enlace se lee de la bandeja del correo simulado (email_outbox, por eso la
// API debe correr con EMAIL_PROVIDER=mock, el valor por defecto) y la cuenta
// se activa con su contraseña, igual que lo haría una persona.
import pg from "pg";
import { api, PASSWORD, writeState } from "./lib.mjs";

const ADMIN_EMAIL = process.env.LOADTEST_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.LOADTEST_ADMIN_PASSWORD || "Password123!";
const DATABASE_URL = process.env.LOADTEST_DATABASE_URL || "postgresql://postgres:postgres@localhost:5433/renta_ia_e2e";

const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const admin = await api("POST", "/api/auth/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });

const LOGIN_USERS = 20;
const LIST_CLIENTS = 250;
const stamp = Date.now();

/** Invitación → correo (email_outbox) → activación. Devuelve la sesión de la cuenta nueva. */
async function register(tag) {
  const email = `carga-${tag}-${stamp}@loadtest.local`;
  await api("POST", "/api/admin/invitations", {
    token: admin.accessToken,
    body: { name: `Usuario ${tag}`, email, role: "accountant" },
  });
  const { rows } = await db.query(
    "SELECT body_text FROM email_outbox WHERE to_address = $1 AND template = 'invitation' ORDER BY created_at DESC LIMIT 1",
    [email]
  );
  const token = rows[0]?.body_text?.match(/#\/invitacion\/([\w.-]+)/)?.[1];
  if (!token) throw new Error(`No llegó la invitación de ${email} a email_outbox (¿EMAIL_PROVIDER=mock?)`);
  const res = await api("POST", "/api/auth/invitations/accept", { body: { token, password: PASSWORD } });
  return { email, token: res.accessToken, id: res.user.id };
}

async function createClients(token, count, prefix) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const c = await api("POST", "/api/clients", {
      token,
      body: { fullName: `${prefix} ${i}`, documentNumber: `LT-${stamp}-${prefix.length}-${i}` },
    });
    ids.push(c.id);
  }
  return ids;
}

const loginUsers = [];
for (let i = 0; i < LOGIN_USERS; i++) loginUsers.push((await register(`login${i}`)).email);

const lister = await register("lista");
await createClients(lister.token, LIST_CLIENTS, "Cliente listado");
const firstPage = await api("GET", "/api/clients?limit=50", { token: lister.token });

const chatter = await register("chat");
const [chatClientId] = await createClients(chatter.token, 1, "Cliente chat");

const uploader = await register("subida");

await db.end();

writeState({
  createdAt: new Date().toISOString(),
  loginUsers,
  list: { email: lister.email, clients: LIST_CLIENTS, page2Cursor: firstPage.nextCursor },
  chat: { email: chatter.email, clientId: chatClientId },
  upload: { email: uploader.email },
});
console.log(
  `Listo: ${LOGIN_USERS} usuarios de login, ${LIST_CLIENTS} clientes para el listado, usuarios de chat y subida.`
);
