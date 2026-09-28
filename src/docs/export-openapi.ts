import fs from "fs";
import path from "path";
import { buildOpenApiDocument } from "./openapi";

// npm run openapi → docs/openapi.json (un test verifica que esté al día).
const target = path.resolve(__dirname, "../../docs/openapi.json");
fs.writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`OpenAPI exportado a ${target}`);
