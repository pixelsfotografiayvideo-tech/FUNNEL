// netlify/functions/capi.js
// Helper para enviar eventos server-side a la Meta Conversions API (CAPI).
// Se usa desde cal-webhook.js, pero queda separado para poder reusarlo
// en otros triggers (formularios, WhatsApp, etc.) sin duplicar código.

const crypto = require("crypto");

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const GRAPH_API_VERSION = "v21.0";

/**
 * Hashea un dato de usuario (email, teléfono) como pide Meta:
 * lowercase, sin espacios, SHA-256.
 */
function hashField(value) {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * Normaliza un teléfono a formato E.164 sin el "+" antes de hashear
 * (mínimo esfuerzo: saca todo lo que no sea dígito).
 * Si el teléfono no tiene código de país, Meta lo va a matchear peor,
 * pero igual conviene mandarlo.
 */
function hashPhone(value) {
  if (!value) return undefined;
  const digitsOnly = String(value).replace(/[^\d]/g, "");
  if (!digitsOnly) return undefined;
  return crypto.createHash("sha256").update(digitsOnly).digest("hex");
}

/**
 * Envía un evento a Meta CAPI.
 *
 * @param {Object} params
 * @param {string} params.eventName - Nombre de evento estándar de Meta (ej: "Schedule", "Lead")
 * @param {string} params.eventId - Id único del evento, para deduplicar con el Pixel del navegador
 * @param {number} params.eventTime - Unix timestamp (segundos) de cuándo ocurrió el evento
 * @param {string} [params.eventSourceUrl] - URL de la página donde ocurrió el evento
 * @param {"website"|"system_generated"} [params.actionSource] - Default "website"
 * @param {Object} params.userData - Datos crudos del usuario (se hashean acá adentro)
 * @param {string} [params.userData.email]
 * @param {string} [params.userData.phone]
 * @param {string} [params.userData.firstName]
 * @param {string} [params.userData.lastName]
 * @param {string} [params.userData.clientIpAddress]
 * @param {string} [params.userData.clientUserAgent]
 * @param {string} [params.userData.fbp] - Cookie _fbp, si la tenés
 * @param {string} [params.userData.fbc] - Cookie _fbc / fbclid, si la tenés
 * @param {Object} [params.customData] - content_name, content_category, value, currency, etc.
 * @param {boolean} [params.testEventCode] - Para probar en Events Manager sin ensuciar data real
 */
async function sendMetaEvent({
  eventName,
  eventId,
  eventTime,
  eventSourceUrl,
  actionSource = "website",
  userData = {},
  customData = {},
  testEventCode,
}) {
  if (!META_PIXEL_ID || !META_ACCESS_TOKEN) {
    throw new Error(
      "Faltan META_PIXEL_ID o META_ACCESS_TOKEN en las variables de entorno."
    );
  }

  const user_data = {
    em: hashField(userData.email) ? [hashField(userData.email)] : undefined,
    ph: hashPhone(userData.phone) ? [hashPhone(userData.phone)] : undefined,
    fn: hashField(userData.firstName)
      ? [hashField(userData.firstName)]
      : undefined,
    ln: hashField(userData.lastName)
      ? [hashField(userData.lastName)]
      : undefined,
    client_ip_address: userData.clientIpAddress || undefined,
    client_user_agent: userData.clientUserAgent || undefined,
    fbp: userData.fbp || undefined,
    fbc: userData.fbc || undefined,
  };

  // Limpiar campos undefined (Meta rechaza algunos payloads con nulls raros)
  Object.keys(user_data).forEach((key) => {
    if (user_data[key] === undefined) delete user_data[key];
  });

  const body = {
    data: [
      {
        event_name: eventName,
        event_time: eventTime || Math.floor(Date.now() / 1000),
        event_id: eventId,
        event_source_url: eventSourceUrl,
        action_source: actionSource,
        user_data,
        custom_data: customData,
      },
    ],
  };

  if (testEventCode) {
    body.test_event_code = testEventCode;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      `Meta CAPI respondió ${response.status}: ${JSON.stringify(result)}`
    );
  }

  return result;
}

module.exports = { sendMetaEvent, hashField, hashPhone };
