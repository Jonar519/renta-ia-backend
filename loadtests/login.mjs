// Escenario: login (POST /api/auth/login) con 20 cuentas distintas.
// Cada login hace bcrypt (costo 10), emite tokens y escribe refresh token + auditoría.
import { PASSWORD, readState, run, save } from "./lib.mjs";

const { loginUsers } = readState();
let i = 0;
const connections = Number(process.env.LOADTEST_CONNECTIONS || 20);
const label = process.env.LOADTEST_LABEL ? `-${process.env.LOADTEST_LABEL}` : "";

const result = await run("login", {
  connections,
  requests: [
    {
      method: "POST",
      path: "/api/auth/login",
      headers: { "Content-Type": "application/json" },
      setupRequest: (req) => ({
        ...req,
        body: JSON.stringify({ email: loginUsers[i++ % loginUsers.length], password: PASSWORD }),
      }),
    },
  ],
});
save(`login-c${connections}${label}.json`, { scenario: "login", result });
