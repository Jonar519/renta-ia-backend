/** Para qué se usó la llamada que falló (la misma etiqueta que AiPurpose en provider.ts). */
type Purpose = "extraction" | "chat" | "summary";

/**
 * El modelo declinó responder (stop_reason "refusal"): no hay texto utilizable. Se lanza en
 * vez de devolver un texto vacío o parcial, para que cada uso decida qué mostrar.
 */
export class AiRefusalError extends Error {
  constructor(readonly purpose: Purpose) {
    super("El modelo de IA declinó responder a esta solicitud.");
    this.name = "AiRefusalError";
  }
}
