// Escenario: listado paginado de clientes (GET /api/clients?limit=50),
// alternando la primera página y la segunda (con cursor); usuario con 250 clientes.
import { login, readState, run, save } from "./lib.mjs";

const state = readState();
const token = await login(state.list.email);
const connections = Number(process.env.LOADTEST_CONNECTIONS || 50);
const label = process.env.LOADTEST_LABEL ? `-${process.env.LOADTEST_LABEL}` : "";
const headers = { Authorization: `Bearer ${token}` };

const result = await run("list", {
  connections,
  requests: [
    { method: "GET", path: "/api/clients?limit=50", headers },
    { method: "GET", path: `/api/clients?limit=50&cursor=${encodeURIComponent(state.list.page2Cursor)}`, headers },
  ],
});
save(`list-c${connections}${label}.json`, { scenario: "list", clients: state.list.clients, result });
