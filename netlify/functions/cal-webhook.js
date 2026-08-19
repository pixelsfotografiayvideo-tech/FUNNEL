// netlify/functions/cal-webhook.js
//
// Recibe el webhook de Cal.com cuando se crea una reserva, valida la firma,
// y manda un evento "Schedule" a Meta Conversions API para que las campañas
// de Meta Ads puedan optimizar en base a reservas reales (no solo clics).
//
// Configurá este webhook en Cal.com → Settings → Developer → Webhooks:
//   URL: https://TU-SITIO.netlify.app/.netlify/functions/cal-webhook
//   Secret: el mismo valor que pusiste en CALCOM_WEBHOOK_SECRET
//   Eventos: Booking Created (como mínimo)

const crypto = require("crypto");
const { sendMetaEvent } = require("./capi");

const CALCOM_WEBHOOK_SECRET = process.env.CALCOM_WEBHOOK_SECRET;

// Mapeo de cada link de reserva (por slug del event type de Cal.com) a
// una categoría de contenido, para poder segmentar después en Ads Manager.
// Actualizá los slugs acá si cambiás los nombres de los event types en Cal.com.
const EVENT_TYPE_MAP = {
  "reunionesdeeventos": { content_name: "Reunión de Eventos", content_category: "eventos" },
  "reuniones-15-anos": { content_name: "Reunión 15 Años", content_category: "quince" },
  "reuniones-zoom": { content_name: "Reunión por Zoom", content_category: "zoom" },
  "reserva-de-book-fotos": { content_name: "Reserva de Book de Fotos", content_category: "book" },
};

/**
 * Verifica que el webhook realmente venga de Cal.com, comparando la firma
 * HMAC-SHA256 del body crudo contra el header x-cal-signature-256.
 */
function isValidSignature(rawBody, signatureHeader) {
  if (!CALCOM_WEBHOOK_SECRET || !signatureHeader) return false;

  const expected = crypto
    .createHmac("sha256", CALCOM_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(signatureHeader, "hex");

  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

/**
 * Busca un campo dentro de las "responses" custom del formulario de Cal.com
 * (por si en tu embed pasás fbp/fbc/landingUrl como hidden fields prellenados).
 */
function getResponseValue(responses, keys) {
  if (!responses) return undefined;
  for (const key of keys) {
    const field = responses[key];
    if (field && field.value) return field.value;
  }
  return undefined;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const signature = event.headers["x-cal-signature-256"];
  const rawBody = event.body || "";

  if (!isValidSignature(rawBody, signature)) {
    console.warn("Firma de Cal.com inválida o faltante");
    return { statusCode: 401, body: "Invalid signature" };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  // Por ahora solo nos importa cuando se crea una reserva nueva.
  // Cal.com también manda BOOKING_CANCELLED, BOOKING_RESCHEDULED, MEETING_ENDED, etc.
  if (payload.triggerEvent !== "BOOKING_CREATED") {
    return { statusCode: 200, body: "Ignored (not a booking creation)" };
  }

  const booking = payload.payload || {};
  const slug = booking.eventType?.slug || booking.type;
  const mapping = EVENT_TYPE_MAP[slug];

  if (!mapping) {
    // No es uno de los 4 event types que estamos rastreando: no rompemos nada,
    // simplemente no mandamos evento a Meta.
    console.log(`Slug "${slug}" no está en EVENT_TYPE_MAP, se ignora.`);
    return { statusCode: 200, body: "Ignored (event type not tracked)" };
  }

  const attendee = (booking.attendees && booking.attendees[0]) || {};
  const responses = booking.responses;

  // Si tu embed de Cal.com pasa estos hidden fields, los recuperamos acá.
  // Si no los pasás, el evento se manda igual pero con menos matching quality.
  const fbp = getResponseValue(responses, ["fbp", "_fbp"]);
  const fbc = getResponseValue(responses, ["fbc", "_fbc", "fbclid"]);
  const landingUrl = getResponseValue(responses, ["landingUrl", "landing_url"]);

  const [firstName, ...rest] = (attendee.name || "").split(" ");
  const lastName = rest.join(" ");

  try {
    const result = await sendMetaEvent({
      eventName: "Schedule",
      eventId: booking.uid, // sirve para deduplicar si también disparás el evento en el navegador
      eventTime: booking.startTime
        ? Math.floor(new Date(booking.createdAt || Date.now()).getTime() / 1000)
        : undefined,
      eventSourceUrl: landingUrl || "https://pixelsfotografiayvideo.com",
      // Si tenemos fbp/fbc es tráfico atribuible a una sesión de navegador real.
      actionSource: fbp || fbc ? "website" : "system_generated",
      userData: {
        email: attendee.email,
        phone: attendee.phoneNumber || attendee.phone,
        firstName,
        lastName,
        fbp,
        fbc,
      },
      customData: {
        content_name: mapping.content_name,
        content_category: mapping.content_category,
        status: "booking_confirmed",
      },
    });

    console.log("Evento enviado a Meta CAPI:", JSON.stringify(result));
    return { statusCode: 200, body: "OK" };
  } catch (err) {
    console.error("Error enviando evento a Meta CAPI:", err.message);
    // Devolvemos 200 igual para que Cal.com no reintente en loop por un error
    // de nuestro lado; el error ya quedó logueado en Netlify.
    return { statusCode: 200, body: "Logged error, see function logs" };
  }
};
