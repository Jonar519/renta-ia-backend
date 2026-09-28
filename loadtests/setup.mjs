// Crea los datos SINTÉTICOS que usan los escenarios (usuarios, clientes) a
// través de la propia API, y guarda lo necesario en loadtests/.state.json.
// Usar SOLO contra una base de pruebas (p. ej. renta_ia_e2e), nunca la real.
import { api, PASSWORD, writeState } from "./lib.mjs";

const LOGIN_USERS = 20;
const LIST_CLIENTS = 250;
const stamp = Date.now();

async function register(tag) {
  const email = `carga-${tag}-${stamp}@loadtest.local`;
  const res = await api("POST", "/api/auth/register", { body: { name: `Usuario ${tag}`, email, password: PASSWORD } });
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
