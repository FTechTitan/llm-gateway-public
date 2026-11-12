// Configuración desde variables de entorno. Falla al arrancar si falta algo obligatorio.
const requerida = (n) => {
  const v = process.env[n];
  if (!v) throw new Error(`Falta la variable de entorno ${n}`);
  return v;
};

export const config = Object.freeze({
  puerto: Number(process.env.PORT || 8080),
  restUrl: process.env.REST_URL || 'http://rest:3000',
  authUrl: process.env.AUTH_URL || 'http://auth:9999',
  serviceJwt: requerida('SERVICE_ROLE_KEY'),
  anonKey: requerida('ANON_KEY'),
  urlPublica: requerida('PUBLIC_URL'),
  claveCifrado: requerida('GATEWAY_ENC_KEY'),      // 32 bytes en base64
  llaveMaestra: requerida('GATEWAY_MASTER_KEY'),   // superadmin por API
  proveedores: {
    openai: process.env.OPENAI_BASE || 'https://api.openai.com',
    anthropic: process.env.ANTHROPIC_BASE || 'https://api.anthropic.com',
  },
  bedrockBase: process.env.BEDROCK_BASE || '',   // solo pruebas; vacío = https://bedrock-runtime.<región>.amazonaws.com
  smtp: {
    host: process.env.SMTP_HOST || '',
    puerto: Number(process.env.SMTP_PORT || 465),
    usuario: process.env.SMTP_USER || '',
    clave: process.env.SMTP_PASS || '',
    de: process.env.SMTP_FROM || '',
  },
  reportePara: (process.env.REPORTE_PARA || '').split(',').map((s) => s.trim()).filter(Boolean),
  reporteHora: Number(process.env.REPORTE_HORA || 8),  // hora de Chile
  inyectarUsoStream: process.env.INYECTAR_USO_STREAM !== 'false',
  maxCuerpoBytes: Number(process.env.MAX_CUERPO_MB || 50) * 1024 * 1024,
});
