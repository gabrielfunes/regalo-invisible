// Sustituto de 'cloudflare:workers' para probar la lógica fuera del runtime.
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') {
    return { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) {} }', shortCircuit: true };
  }
  return next(specifier, context);
}
