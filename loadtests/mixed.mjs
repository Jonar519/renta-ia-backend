// Escenario: login y listado A LA VEZ. Muestra si el costo de un endpoint
// (bcrypt en el login) degrada a los demás (bloqueo del event loop).
import { PASSWORD, login, readState, run, save } from "./lib.mjs";

const state = readState();
const token = await login(state.list.email);
let i = 0;
const label = process.env.LOADTEST_LABEL ? `-${process.env.LOADTEST_LABEL}` : "";

const [loginResult, listResult] = await Promise.all([
  run("login (simultáneo)", {
    connections: 20,
    requests: [
      {
        method: "POST",
        path: "/api/auth/login",
        headers: { "Content-Type": "application/json" },
        setupRequest: (req) => ({
          ...req,
          body: JSON.stringify({ email: state.loginUsers[i++ % state.loginUsers.length], password: PASSWORD }),
        }),
      },
    ],
  }),
  run("list (simultáneo)", {
    connections: 50,
    requests: [{ method: "GET", path: "/api/clients?limit=50", headers: { Authorization: `Bearer ${token}` } }],
  }),
]);
save(`mixed${label}.json`, { scenario: "mixed", login: loginResult, list: listResult });
